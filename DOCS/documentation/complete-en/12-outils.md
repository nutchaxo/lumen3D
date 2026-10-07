# 12. The tools, one by one

::: chapter-intro
- This chapter is the **user manual** for every button of the viewer, the Compare page, the timeline and the 2D page.
- Each tool follows the same plan: **what it is for**, **how to use it**, **what it really does** (in plain words) and **its limits**.
- Every screenshot shows the **demo dataset** (synthetic embryos generated for this documentation, not real laboratory data).
:::

## 12.1 The toolbar at a glance

Hover over a button and a tooltip gives its name. The bar is arranged in **five groups** (Tools, Export, Visuals, Layouts, Help). When the window is narrow or the title very long, the bar folds behind the ☰ button.

![The viewer toolbar, numbered (demo dataset).](img-en/ch12/barre-outils.png){.shot width=92%}

:::::: cols
::::: col
::: legend
| n | what it is |
|---|---|
| 1 | [Navigate]{.ui} (<kbd>V</kbd> or <kbd>Esc</kbd>) |
| 2 | [Slice through volume]{.ui} (<kbd>C</kbd>) |
| 3 | [Measure distance]{.ui} (<kbd>M</kbd>) |
| 4 | [Download Center]{.ui} |
| 5 | "Sandboxed" capture (demonstration plugin) |
| 6 | [Screenshot]{.ui} |
| 7 | [Toggle Grid (None / Normal / Fine)]{.ui} |
| 8 | [Toggle Axes]{.ui} |
| 9 | [Toggle Orientation Axes]{.ui} |
| 10 | [Hide / Show 3D Volume (keep projections)]{.ui} |
| 11 | [Chunk debug (brick boundaries)]{.ui} |
:::
:::::
::::: col
::: legend
| n | what it is |
|---|---|
| 12 | [Presentation mode]{.ui} |
| 13 | [Decompose by channel]{.ui} |
| 14 | [Z-Stack Browser]{.ui} |
| 15 | [Help and methods]{.ui}: a link to the About page (presentation and methods) |
| 16 | [Colorblind filters]{.ui} |
| 17 | [Toggle theme]{.ui} (light / dark) |
| 18 | [Center sample]{.ui} |
| 19 | [Reset View]{.ui} |
| 20 | [Export the 3D view as PNG]{.ui} |
| 21 | [Reset the workspace (view, tools, measurements)]{.ui} |
| 22 | The [Channels]{.ui} panel (see chapter 11) |
:::
:::::
::::::

::: note
**Your toolbar may look different.** The tools are *plugins* that the administrator installs from the catalogue (chapter 15). Chunk debug, the "sandboxed" capture and the 2D tools are optional. The cell-tracking tools appear only on a tracked time series.
:::

### I want to… → I use…

| I want to… | I use… | Shortcut |
|---|---|---|
| Measure a distance in µm | [Measure distance]{.ui} | <kbd>M</kbd> |
| See a slice, even an oblique one | [Slice through volume]{.ui} | <kbd>C</kbd> |
| Page through the planes one by one | [Z-Stack Browser]{.ui} | — |
| Know where the front of the embryo is | [Toggle Orientation Axes]{.ui} | — |
| An annotated figure for a paper | The Studio (§ 12.7) | — |
| A very large or transparent 3D image | [Export the 3D view as PNG]{.ui} | — |
| A quick screen capture | [Screenshot]{.ui} | — |
| One panel per channel | [Decompose by channel]{.ui} | — |
| Get the original file | [Download Center]{.ui} | — |
| Compare two embryos | The Compare page (§ 12.8) | — |
| Follow cells over time | The five tracking tools (§ 12.9) | <kbd>I</kbd>, <kbd>D</kbd> |
| Share what I am seeing | Copy the page address (§ 12.11) | — |

## 12.2 Measuring a distance

::: tldr
- **What it is for**: finding, in micrometres, the distance between two points of the volume.
- The point is not dropped "at random": it lands on **the first bright structure** under your cursor.
- A click in empty space is **refused**.
:::

![Two points (1, 2), the segment and the list of measurements. Demo dataset, 204.8 µm.](img-en/ch12/mesure-distance.png){.shot width=88%}

::: legend
| n | what it is |
|---|---|
| 1, 2 | Points A and B, placed by your two clicks |
| 3 | The list: colour, editable name, value, eye (hide), bin |
| 4 | [3D values]{.ui} checkbox: shows or hides the label in the view, with its size slider |
| 5 | The instruction of the [Distance Measurement]{.ui} panel |
:::

::: steps
1. Press <kbd>M</kbd> (or click the ruler). The [Distance Measurement]{.ui} panel opens.
2. Click point A on a **visible** part of the specimen.
3. Click point B: the distance and the Z difference are displayed, and a coloured segment appears.
4. A third click starts a new measurement. Drag to rotate the embryo without placing a point.
:::

### How the point is found

The viewer keeps **no copy** of the volume in main memory: it asks the graphics card. For your click it redraws a mini-render of **a single pixel** with exactly the same settings as the screen (window, gamma, channels switched on, cropping).

![The measured point is the first structure that reaches 55% of the displayed maximum.](img-en/ch12/pick.svg){width=85%}

::: tech
Two passes along the ray. Pass 1: the displayed maximum `m`. Pass 2: the first point where the displayed value reaches `max(0.02, 0.55 × m)`, interpolated between the two samples on either side of the threshold. The 0.02 floor stops the viewer from "measuring" noise when everything is almost black. Consequence: **switching a channel off or changing its window moves the point** (you measure what you see).
:::

::: warning
A click with no structure beneath it (black background) is **refused**: [No structure under the cursor: click on a visible part of the specimen.]{.ui} Without physical calibration in the metadata, the measurement is refused too. On a **wall of the grid** (§ 12.5), the point is placed on the wall, not on the specimen.
:::

### The calculation, with real numbers

The normalised coordinates (0 to 1) are converted to micrometres with the physical size of the volume (number of voxels × voxel size). Then, on the **physical** coordinates:

`d = √( (Δx)² + (Δy)² + (Δz)² )`

::: example
The points of the screenshot: A = (498.5, 163.4, 211.1) µm and B = (639.3, 311.9, 203.2) µm. The differences are Δx = 140.8, Δy = 148.5, Δz = 8.0 µm. So d = √(19,838 + 22,043 + 63) = √41,944 ≈ **204.8 µm**, the value displayed.
:::

![Why you cannot "count voxels": Z is 2.5 times longer.](img-en/ch12/voxels.svg){width=80%}

::: why
The demo dataset has voxels of 1.2 × 1.2 × 3.0 µm. Counting voxels as if they were cubic would underestimate a diagonal distance here by 20%. The viewer always does the calculation in µm, never in voxels.
:::

**Where are the measurements kept?** Only **in the memory of the page**: closing the tab erases them. To keep them, copy the page address (they travel in the link, § 12.11) or download [Measurements CSV]{.ui} from the Download Center.

### The scale bar of the 3D view

Switch the grid on (button 7): a scale bar appears at the bottom right, with a "round" length (the **1-2-5** rule: 1, 2, 5, 10, 20, 50, 100 µm…). It aims at about 20% of the width of the view, between 60 and 200 pixels.

![The grid and the scale bar (1): 100 µm. The grid button is number 2.](img-en/ch12/grille-echelle.png){.shot width=80%}

Because of **perspective**, a distant object looks smaller: the bar is exact only at the depth of the **centre of the specimen**.

![Same length, three depths: the bar holds for the central plane.](img-en/ch12/perspective.svg){width=80%}

::: tech
µm per pixel = 2·tan(field of view/2) · depth · (physical size X / cube scale) / height of the view in pixels. The bar is hidden without calibration or when the grid is off.
:::

## 12.3 The oblique slice

::: tldr
- **What it is for**: seeing a flat slice of the volume, straight or tilted, instead of the overall view.
- While the tool is open, **the two views swap places**: the slice fills the screen and the 3D view becomes a small window.
- It cannot be used at the same time as the Z-stack browser.
:::

![XY slice through the middle of the volume (demo dataset).](img-en/ch12/coupe-oblique.png){.shot width=88%}

:::::: cols
::::: col
::: legend
| n | what it is |
|---|---|
| 1 | The slice, computed by the graphics card, in the colours of your channels |
| 2 | Exact scale bar of the slice (200 µm here) |
| 3 | The volume in miniature: the plane is moved there |
| 4 | [XY]{.ui}, [XZ]{.ui}, [YZ]{.ui} presets |
:::
:::::
::::: col
::: legend
| n | what it is |
|---|---|
| 5 | Plane [Position]{.ui}, then [Yaw]{.ui}, [Pitch]{.ui}, [Roll]{.ui} |
| 6 | [Slab thickness]{.ui}: number of samples in the slab |
| 7 | [Projection]{.ui}: [Single]{.ui}, [MIP]{.ui} or [Average]{.ui} |
| 8 | [Open in Studio (HD)]{.ui}: sends the slice to the Studio (§ 12.7) |
:::
:::::
::::::

::: steps
1. Press <kbd>C</kbd>: a translucent plane appears and the slice fills the screen.
2. Choose a preset, or move the plane in the miniature (mouse wheel on the plane: 2% of the volume per notch).
3. The [Yaw]{.ui}, [Pitch]{.ui} and [Roll]{.ui} sliders make the plane **oblique**.
4. Thicken the slab and choose how to flatten it: a single slice, the brightest value (MIP) or the average.
:::

::: tech
The slice reads the **same atlas** as the 3D view, so the windows, gamma and colours are the same. The plane is the rotation Ry(−yaw)·Rx(−pitch)·Rz(roll) in the frame with physical proportions; because voxels are longer in Z, the plane's normal is corrected (n_tex ∝ S⁻¹·n). While you move the plane the image is 1,024 px; once it is still (160 ms) it is refined up to 2,048 px. A thickness counts in samples (at most 1,024), not in µm.
:::

::: warning
The XY/XZ/YZ presets follow the axes **of the file**, not those of the embryo, unless the dataset has been calibrated (§ 12.5).
:::

## 12.4 The Z-stack browser

::: tldr
- **What it is for**: paging through the planes of the stack as in a microscopy program.
- On opening, the stack **lays itself flat** in 1.5 s, upper face towards you.
- The cursor can show one slice, several slices (a "thickness") or the whole stack in 3D.
:::

::::::: cols-wide-left
:::::: col
![Z-stack in slice mode: 12 slices (59 to 70), i.e. 36 µm.](img-en/ch12/zstack-coupe-c.png){.shot width=100%}
::::::
:::::: col
::: legend
| n | what it is |
|---|---|
| 1 | The **cursor**: its height = number of slices shown |
| 2 | [59–70 / 112]{.ui}: slices displayed / total |
| 3 | [Thickness]{.ui}: 12 slices = 36.00 µm |
| 4 | [Rotation]{.ui} 0–360° |
| 5 | Position: 174 to 207 µm deep |
| 6 | [Open in Slice Studio]{.ui}: sends the slab to the Studio |
| 7 | The **3D notch**: cursor here = the whole stack in 3D |
| 8 | The **track**: one position per slice |
| 9 | **Trim triangles** (above / below) |
:::
::::::
:::::::

::: steps
1. Click [Z-Stack Browser]{.ui}: the stack lays itself flat, in 3D mode (notch 7).
2. Drag the cursor **down** into the track (8): the view locks from above onto the chosen slice.
3. Drag an **edge** of the cursor, or the [Thickness]{.ui} button, to show several slices.
4. The triangles (9) hide slices at the top or bottom ([All 112 slices kept]{.ui} becomes [Kept …]{.ui}). Move the cursor back up into notch 7 to return to 3D.
:::

::: tech
A single operation crops the volume in Z: `setClipRange_z` with the interval `[start / z ; (end+1) / z]`. The render calculation is confined to this box and corrects the emission ("thin-slab gain") so that a single slice is not black. Depth = index × voxel size in Z (3 µm here). From the keyboard, with the cursor selected: ↑ ↓ one slice, Page Up/Page Down 10% of the stack, Home = 3D notch, End = last slice, + / − thickness.
:::

**An "upside-down" specimen.** Some Imaris files show the specimen seen from below. The administrator records this in the metadata (`upsideDown`): the "upper face" is then the −Z face, and the Z-stack, like the Studio figures, presents it the right way up. The orientation calibration does not depend on it.

## 12.5 Orientation axes, the grid and the displays

::: tldr
- **Orientation axes**: a compass for the embryo (R1/R2, G1/G2, B1/B2).
- **Grid**: three graduated walls with projections; **Axes**: a movable XYZ marker.
- **Volume**: hides the 3D volume while keeping the projections.
:::

### The orientation axes

![The compass: red R1/R2 (±X), green G1/G2 (±Y), blue B1/B2 (±Z).](img-en/ch12/orientation.png){.shot width=80%}

Each arm has a **short name** (R1, R2, G1, G2, B1, B2). The administrator can rename them ("Anterior", "Dorsal"…) or hide some. Drag the small central sphere to move the compass; its position is kept in the workspace.

::: analogy
**An orientation calibration is a hand gesture.** The microscope records the embryo in the orientation it was lying in, not "head up". The calibration says: "to put the embryo the right way up, turn the file in **one** movement, around **this** axis, by **this many** degrees". The computer stores that gesture as four numbers (a *quaternion*). You have nothing to set: the administrator does it once, in the administration panel.
:::

**The default view** is a pose of the embryo (for example "ventral face, anterior up") saved with the dataset: it is applied **before** the first brick is loaded, and the [Reset View]{.ui} button returns to it. The presets offered are ventral, dorsal, left, right, anterior, posterior.

::: tech
The file has its rotation `Q_base` (file axes → anatomical axes). The compass is drawn with `Q_anat = Q_cube · Q_base⁻¹`, and a default view is stored as `Q_anat` and applied as `Q_cube = Q_anat · Q_base`. The calibration can be edited only from the administration (preview ↔ viewer by messages); a visitor can neither change it nor save a default view.
:::

### The grid, the axes, the volume

- **Grid** (7): each click cycles through *None → Normal (10 divisions) → Fine (40) → None*. The three walls show a **projection** of the volume with the same render mode. An orange handle resizes a wall (double-click: back to normal).
- **Axes** (8): a coloured XYZ marker, not to be confused with the compass. Drag its sphere to move it.
- **Volume** (10): hides the ray-marched volume; the grid, the axes, the measurements and the tracking remain.

## 12.6 Capture, export, presentation, download, channels, chunks

::: tldr
- Three ways to get an image: [Screenshot]{.ui} (quick), [Export the 3D view as PNG]{.ui} (large size), the Studio (annotated figure).
- The [Download Center]{.ui} does not give captures: it gives the **files** of the dataset.
:::

### Screenshot and 3D view export

The **screenshot** (button 6) saves what is on screen in one click, as a PNG (`<dataset>_screenshot.png`), at the screen's resolution.

The **3D view export** (button 20) redoes the render **at any size**.

:::::: cols
::::: col
![The export window (2). Button 1 opens it.](img-en/ch12/export-vue-c.png){.shot width=100%}
:::::
::::: col
- [Size]{.ui}: [Screen]{.ui}, 2×, 4×, [Custom]{.ui} (width from 16 to 16,384 px).
- [Background]{.ui}: as displayed, [Transparent]{.ui}, black, white.
- [Scale bar]{.ui}: disabled without calibration (it would count voxels, not µm).
- File: `<dataset>_3d_<W>x<H>.png`.
:::::
::::::

::: tech
A graphics card cannot draw a giant image in one go. The viewer waits for loading to finish, then renders the view **in tiles** of at most 2,048 px (each is a window of the field of view, one tile per task so the page does not freeze) with the number of steps of a render at rest. The transparent background writes an opacity per pixel `a = max(opacity, max(channels))`; over black, it gives back the screen. If the display changes during the render, it starts again (3 attempts). Ceiling: 16,384 px per side, 268 megapixels.
:::

### Presentation mode

Button 12 hides the interface so that the volume fills the screen: useful for projecting or filming. Press the same button to go back.

### Download Center

![The files of a dataset's `download/` folder (demo dataset).](img-en/ch12/centre-telechargement.png){.shot width=72%}

In the viewer it shows a **list of files**: the original Imaris file, the calibrated TIFF, the per-channel projections (PNG), the web archive and a README file. They exist only if the pipeline was run with downloads (chapter 8). These files are always served as an **attachment**. If there are measurements, a [Measurements CSV]{.ui} button appears (columns: label, type, distance, unit, point A, point B…).

### Decompose by channel

::::::: cols-wide-left
:::::: col
![One thumbnail per channel: DAPI, Pecam1, Sox2.](img-en/ch12/decomposer-c.png){.shot width=100%}
::::::
:::::: col
Each channel that is switched on gets its **thumbnail** (the same volume, with that channel alone). Clicking a thumbnail lets you adjust that channel in the left-hand panel ([Done]{.ui} to leave, [Reset to original]{.ui}). The three buttons (1) choose the layout; [Export]{.ui} (2) writes a PNG `decomposition_<layout>_<date>.png`. Each thumbnail is rendered at the size of the volume (512 to 4,096 px) and the viewer refuses an image too large for the graphics card ("Too many views to export as one image").
::::::
:::::::

### Chunk debug

![The 64³-voxel bricks drawn in yellow; hovering over one of them.](img-en/ch12/chunk-debug.png){.shot width=84%}

The most instructive tool of chapter 7: it **draws the edges of every non-empty brick** of the displayed level. Hover over a brick to see its identifier, its size (here 64×64×48 voxels, 76.8 × 76.8 × 144 µm), its stored size (66³ with a one-voxel border), its pack file and its level of detail. Click: copies this information. <kbd>Ctrl</kbd> + wheel: steps through the overlapping bricks under the cursor.

## 12.7 The Studio: annotating and exporting a figure

::: tldr
- **What it is for**: making a publication figure from a slice (scale bar, arrows, measurements, text).
- It opens **immediately** on a preview, then reloads the slice at **native resolution**.
- Channels are **recoloured** in the Studio without re-rendering the volume.
:::

![The Slice Studio with a rectangle rotated by 20°, an arrow, a distance and a scale bar.](img-en/ch12/studio.png){.shot width=92%}

:::::: cols
::::: col
::: legend
| n | what it is |
|---|---|
| 1 | Tools: select, rectangle, ellipse, arrow, line, text, distance, angle, scale bar |
| 2 | Layers (reorder, hide, lock) |
| 3 | A distance measurement: 399.68 µm (label computed in µm; the figure writes the unit as "um") |
| 4 | [Properties]{.ui} of the chosen layer: name, colour, opacity, thickness, [Rotation]{.ui} (−180 to 180°) |
| 5 | [Channels]{.ui}: colour, min/max, gamma, on/off, with their histograms |
:::
:::::
::::: col
::: legend
| n | what it is |
|---|---|
| 6 | [Import JSON]{.ui} / [Save JSON]{.ui} |
| 7 | [Export PNG]{.ui} |
| 8 | Rotation of the **view** (display only) |
| 9 | Mini-map |
:::
:::::
::::::

::: steps
1. From the oblique slice or the Z-stack, click the button that opens the Studio.
2. Annotate: each tool has a letter (table in § 12.11). A scale bar is placed on opening if the volume is calibrated.
3. Recolour the channels if needed (right-hand column).
4. [Export PNG]{.ui} for the image, [Save JSON]{.ui} to be able to resume later.
:::

### The layers

- **Distance**: the label is `√((Δx·px_x)² + (Δy·px_y)²)` µm, with the pixel size of the figure. **Angle**: three clicks, computed in µm. **Scale bar**: its length (µm, mm, cm or px) is converted to pixels.
- **Layer rotation**: a rectangle, ellipse or text turns about its centre; a line, arrow or distance has its points rotated (the distance keeps its value in µm). Slider, field, handle above the selection (<kbd>Shift</kbd> = 15° steps), or <kbd>[</kbd> / <kbd>]</kbd>.
- The history keeps 80 steps (<kbd>Ctrl</kbd>+<kbd>Z</kbd>).

### The "native" pass

The preview (at most 2,048 px) comes from the graphics card. The native pass fetches the **voxels at maximum resolution** for this exact plane, and replaces the image as they arrive. A bar shows bytes, chunks and time remaining, with [Stop here]{.ui}.

- An **XY** slice of a format 2 (or later) dataset reads the `planes/` folder: only the voxels of the plane.
- An **oblique** plane or an old volume goes through the bricks (targeted byte reads, chapter 10).
- A brick that is absent because it is empty counts as **zero**, never as "missing".
- If a figure needs more than 256 MB, a dialogue offers native, reduced resolution or preview.

::: note
On the demo dataset (768 × 576 px), the native version is as small as the preview: the progress bar has almost nothing to load. It comes into its own on a volume of several gigabytes.
:::

### Exports and limits

- **PNG**: native size, black background, with a **caption line always burned in** at the top left (dataset | plane | size | pixel). Refused beyond 16,384 px per side or 2²⁸ pixels.
- **JSON** (`<dataset>_studio.json`): layers, guides, channels, plane, calibration. **Never any pixels.** On import, a file larger than **5 MB**, or with more than 2,000 layers or 10,000 points, is refused; a file from another figure applies only its layers.
- Beyond 4 channels, only the first 4 are shown. Without calibration: no scale bar, and measurements are in pixels.

## 12.8 The Compare page

::: tldr
- **What it is for**: displaying up to **four** datasets side by side, with the views kept in sync.
- Each panel is the **real page** of the viewer (or of the 2D page): same tools, same shortcuts.
- A single graphics memory is **shared** between the panels (automatic quality).
:::

![Three panels: two volumes and a photograph. (1) add, (2) common tools, (8) synchronisations.](img-en/ch12/comparer.png){.shot width=92%}

:::::: cols
::::: col
::: legend
| n | what it is |
|---|---|
| 1 | [Add Dataset]{.ui} (search, filter by type) |
| 2 | Common tools: what the open pages offer |
| 3 | [Studio]{.ui}: one figure with all the panels |
| 4 | [Export]{.ui}: PNG / WebP figure of the grid |
| 5 | [Save]{.ui} / [Restore]{.ui} the workspace |
:::
:::::
::::: col
::: legend
| n | what it is |
|---|---|
| 6 | [Auto layout]{.ui}: Auto, columns, rows, grid (adjustable gutters) |
| 7 | [Auto quality]{.ui}: auto, 512, 1024, native |
| 8 | SYNC: [Z-Stack]{.ui}, [Time]{.ui}, [Camera / view]{.ui}, [Channels]{.ui} |
| 9 | The name of the panel's dataset |
| 10 | The toggle buttons **described by the page** of this panel |
:::
:::::
::::::

### What is synchronised

| Option | What travels between panels |
|---|---|
| [Z-Stack]{.ui} | Z-stack slice, plane of the oblique slice |
| [Time]{.ui} | position in the series, **as a fraction** (frame = fraction × (N − 1)): 100 frames and 10 frames stay aligned |
| [Camera / view]{.ui} | 3D viewing angle (corrected for each panel's calibration); for a photograph, the physical scale |
| [Channels]{.ui} | state and exposure, **by channel name** |

A panel added late is "caught up": it receives the latest camera, the latest time, and so on.

### The shared memory

::: analogy
**A buffet on a fixed budget.** Compare keeps a **fixed** shared budget of 1.5 GiB for all the panels (it is not a measurement of your graphics card). Each volume says what each quality costs. The viewer lowers the hungriest one while the total is too high, then raises the most modest one while it still fits, never going above 1024 in automatic mode. This setting only concerns **volumes**: a 2D photograph has no quality.
:::

Panels start at 512; quality is raised **one panel at a time**; a panel that does not settle within 180 s is abandoned (message in the console) and the next one is handled. Choosing 512/1024/Native by hand forces the level.

### Decompose, figure, workspace

![A three-channel volume, [Decompose]{.ui}: three panels, one channel each. The [Channels]{.ui} sync (1) was unticked automatically.](img-en/ch12/comparer-decomposer.png){.shot width=85%}

- **Decompose** appears only when there is **one** multi-channel volume panel: it clones it into panels (4 at most), one channel each, keeping time and camera in sync.
- **Studio**: one figure with all the panels, in [Visual Size]{.ui} or [Physical Scale]{.ui} (a single scale in µm/px for all, never upsampled).
- **Export** composes the visible grid (4,096 px per side at most).
- **Save** keeps the workspace in the browser; **Restore** reloads it. The page address also contains the state (`#state=…`).

## 12.9 The timeline and cell tracking

::: tldr
- A **time series** (*Live* type) adds a timeline at the bottom of the screen to play it.
- If it has cell tracking, **five tools** are added: trajectories, surface, inspector, cell distance, charts.
- Example: the 4-frame demo dataset with tracking (50 cells).
:::

![The timeline: play (1), speed (2), counter (3), track (4); and the [Tracking points]{.ui} layer (5).](img-en/ch12/timeline-c.png){.shot width=100%}

::: legend
| n | what it is |
|---|---|
| 1 | Play / pause |
| 2 | Speed: each click cycles through 0.5 → 1 → 2 → 5 → 10 → 20 fps |
| 3 | Counter: current frame / last frame (000 / 003 = 4 frames) |
| 4 | Track: drag to go to a frame; the band shows the frames already loaded |
| 5 | Tracking points layer: size, opacity, mitoses, fusions, legend per region |
:::

- Playback skips frames rather than piling them up; the clock **waits** for a frame that has not arrived (up to 15 s).
- The following frames are preloaded. [Buffer 4/4 · 512×512]{.ui} shows what fits in memory.
- There is no clock in minutes on the timeline: the display is a frame number.

::::::: cols
:::::: col
![On this series the bar is folded: the ☰ menu groups the tracking tools.](img-en/ch12/suivi-menu.png){.shot width=100%}
::::::
:::::: col
::: legend
| n | what it is |
|---|---|
| 1 | [Inspect cell]{.ui} (<kbd>I</kbd>) |
| 2 | [Cell distance]{.ui} (<kbd>D</kbd>) |
| 3 | [Tracking charts]{.ui} |
| 4 | [Trajectories]{.ui} |
| 5 | [Tracking surface]{.ui} |
:::
::::::
:::::::

### Trajectories and surface

::::::: cols-wide-left
:::::: col
![[Trajectories]{.ui} (1) and [Tracking surface]{.ui} (2) in the left-hand column, last frame.](img-en/ch12/suivi-trajectoires-c.png){.shot width=100%}
::::::
:::::: col
- **Trajectories**: trail length (0 = all frames), path ahead, opacity, colour by **region** or by **speed** (blue slow → red fast, fixed scale across the whole series).
- **Tracking surface**: the tissue surface (`model.glb`) inside the volume, coloured uniformly, by **cell density** or by region, with a palette of your choice and a **cutting plane** (XY, XZ, YZ or oblique).
::::::
:::::::

::: tech
Local density at a vertex: sum of Gaussians `exp(−|v−c|²/2σ²)` over the cells of the current frame, with σ = 0.52 × neighbourhood radius, bounded between 8 and 54 µm, then two smoothing passes over the mesh. Speed of a segment: |Δposition| in µm / Δt.
:::

::: warning
On the demo dataset, the cells move only a few micrometres between two frames: no line was legible in our captures in software rendering. The sliders and the summary do apply; try it on a real series.
:::

### Inspecting a cell

![Cell 15 selected (1). Left-hand column: identifier (2), metrics (3), neighbours (4).](img-en/ch12/suivi-inspecteur-c.png){.shot width=100%}

::: steps
1. Press <kbd>I</kbd>, then click a sphere (or type its number and [Find]{.ui}).
2. Read the tiles: track, region, frames, mean speed, path length, net displacement, straightness, event.
3. Explore the lineage (mother, daughters) and the **neighbours** within 35, 55, 85 or 120 µm.
:::

::: tech
Path length = Σ |p(f+1) − p(f)|; net displacement = |p(last) − p(first)|; **straightness = displacement / length** (1 = straight line). Mean speed = length / duration, in µm/frame, and in µm/min if the interval is known. Here 4.35 µm of path for 4.04 µm of displacement: straightness 0.93.
:::

Export buttons: [Track CSV]{.ui}, [Neighbours CSV]{.ui}, [Lineage JSON]{.ui}.

### Cell distance and charts

:::::: cols
::::: col
![Two cells (1, 2) and the panel (3): 41.4 µm.](img-en/ch12/suivi-distance-c.png){.shot width=100%}
:::::
::::: col
![Population by region (demo dataset).](img-en/ch12/suivi-graphiques-c.png){.shot width=100%}
:::::
::::::

- **Cell distance** (<kbd>D</kbd>): click two tracked cells. [Snapshot]{.ui} mode (positions kept) or [Follow cells]{.ui} (re-read at each frame; "Out of frame" if one disappears). Formula: √(Δx² + Δy² + Δz²) in µm.
- **Tracking charts**: [Population]{.ui}, [Velocity]{.ui}, [Neighbours]{.ui}, [Mitoses]{.ui}, [Linear]{.ui} or [Log]{.ui} scale, one curve per region.

## 12.10 The 2D page: photographs

::: tldr
- **What it is for**: displaying a calibrated photograph (stereomicroscope, here X-gal), measuring it and comparing it.
- The engine is simpler than in 3D: a canvas you pan and zoom.
- **Isolating the staining** is a visual aid: nothing that is measured reads from it.
:::

![The 2D page (1 to 17: the buttons; 18: scale bar; 19: zoom and µm/px; 20: specimen sheet).](img-en/ch12/2d-barre.png){.shot width=92%}

:::::: cols
::::: col
::: legend
| n | what it is |
|---|---|
| 1, 2 | [Navigate]{.ui}, [Measure distance]{.ui} |
| 3 | [Open in Studio (annotate)]{.ui} |
| 4, 5, 6 | Download, [Figure panel builder]{.ui}, capture |
| 7, 8 | [Fit to screen (F)]{.ui}, [Native resolution 1:1]{.ui} |
:::
:::::
::::: col
::: legend
| n | what it is |
|---|---|
| 9 | [Isolate the staining]{.ui} |
| 10, 11, 12 | [Calibrated grid]{.ui}, [Display adjustments]{.ui}, [Orientation]{.ui} |
| 13, 14, 15 | Previous photograph, browse the collection, next |
| 16, 17 | Presentation mode, [Split view]{.ui} |
:::
:::::
::::::

- **Navigation**: wheel to zoom around the cursor, drag to pan, double-click to fit. Zoom ranges from 0.25 × the fit up to 32 screen pixels per image pixel.
- **Two-stage loading**: a preview (≈ 640 px), then the native image.
- **Scale bar** at the bottom left, 1-2-5 value, computed with the pixel size (here 2.000 µm/px). Without calibration: [Uncalibrated]{.ui}.
- [Browse the collection]{.ui} (<kbd>B</kbd>) opens a contact sheet that can be filtered by stage and line.

![A measurement: 1.58 mm (1.576 mm in the list).](img-en/ch12/2d-mesure.png){.shot width=80%}

The measurement is `√(Δx² + Δy²) × pixel size`: the photograph is flat, there is no Z. Labels can be moved with the mouse.

### Isolating the staining (X-gal)

![Before (left) and after (right): the blue staining stands out, the rest turns dark grey.](img-en/ch12/2d-avant-apres.png){.shot width=100%}

X-gal makes a pixel **bluer** than the neighbouring tissue. But the matt background also carries bluish grains. To avoid lighting them up, the tool requires the blue to be **inside yellow tissue**.

![The calculation, pixel by pixel.](img-en/ch12/xgal.svg){width=90%}

::: tech
Constants from the code: low ratio 1.0, high 1.8; context at 1/4 resolution, blur of radius 5 (≈ 40 px), threshold 5. Brightness = 0.299 R + 0.587 G + 0.114 B. All of it runs in a *worker* (the page stays smooth), only the latest request is processed, and the context map is kept as long as the image does not change. The tool is tuned for X-gal on yellow tissue: other stains or backgrounds may be detected badly.
:::

### Display, grid, orientation

![[Calibrated grid]{.ui} (200 µm): a reading scale over the photograph.](img-en/ch12/2d-grille.png){.shot width=80%}


::::::: cols-wide-left
:::::: col
![[Display adjustments]{.ui} ([Display]{.ui} panel).](img-en/ch12/2d-affichage-c.png){.shot width=100%}
::::::
:::::: col
- **Display adjustments**: [Brightness]{.ui}, [Contrast]{.ui}, [Gamma]{.ui}, [Red]{.ui}/[Blue]{.ui} balance, [Flatten the background (vignetting)]{.ui}. *Display only*: measurements read the untouched photo. Per channel: `x = (v/255 · balance − ½)(1 + contrast/100) + ½ + brightness/100`, then `x^(1/gamma)`.
- **Flatten the background**: a smoothed (quadratic) surface is fitted to the darkest 40% of pixels (the background) and the corresponding gain is applied, between 0.5 and 3.
::::::
:::::::

- **Calibrated grid**: one click = none → wide (≈ 120 px) → fine (≈ 60 px), not in 1-2-5 µm steps.

![[Orientation]{.ui}: rotation of 25°, compass A (anterior) / P (posterior).](img-en/ch12/2d-orientation.png){.shot width=75%}

**Orientation** turns the image without changing the scale (rotation, ±90°, mirror). The administrator saves the pose with the dataset; it is reapplied each time the photograph is opened.

### Split view and figure panel

![[Split view]{.ui}: two embryos at the **same physical magnification**.](img-en/ch12/2d-vue-divisee.png){.shot width=85%}

The split view exchanges a **physical** view (µm per screen pixel + position) between the two sides: two photos taken at different zooms are at the same scale, and moving one moves the other by the same real distance.

![The [Figure panel builder]{.ui}: list (1), options (2), preview (3), export (4).](img-en/ch12/2d-planche.png){.shot width=80%}

The panel assembles several photographs into one PNG: **same physical scale** (one common bar; each image is brought to the coarsest pixel, never enlarged) or **same image size** (one bar per panel). Limits: 6,000 px wide, 120 megapixels. It also opens in the Studio.

## 12.11 Keyboard shortcuts and sharing a view

::: tldr
- Shortcuts are ignored while you are typing in a field.
- **Sharing a view** = copying the page address: the state is in the link.
:::

:::::: cols
::::: col
**3D viewer**

| Key | Action |
|---|---|
| <kbd>V</kbd> / <kbd>Esc</kbd> | Navigate |
| <kbd>C</kbd> | Slice |
| <kbd>M</kbd> | Measure |
| <kbd>I</kbd> | Inspect a cell |
| <kbd>D</kbd> | Distance between cells |

**2D page**

| Key | Action |
|---|---|
| ← / → | Previous / next photo |
| <kbd>B</kbd> | Contact sheet |
| <kbd>F</kbd> | Fit to screen |
:::::
::::: col
**Studio**

| Key | Action |
|---|---|
| <kbd>V</kbd> <kbd>R</kbd> <kbd>E</kbd> | Select, rectangle, ellipse |
| <kbd>A</kbd> <kbd>L</kbd> <kbd>T</kbd> | Arrow, line, text |
| <kbd>D</kbd> <kbd>G</kbd> <kbd>S</kbd> | Distance, angle, scale bar |
| <kbd>Space</kbd> | Pan (held down) |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | Command palette |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo |
| <kbd>Delete</kbd> | Delete the layer |
| <kbd>[</kbd> / <kbd>]</kbd> | Rotate by −15° / +15° |

**Mouse**: left-drag = rotate; <kbd>Shift</kbd> or right/middle click = pan; wheel = zoom.
:::::
::::::

### Sharing a view

Every second the page writes its state into the address (`#state=…`, compressed): camera, channels, active tool, cutting plane, **measurements**, frame of the series, quality, tool settings. Simply copy the address.

- Whoever opens the link sees: [This link carries a saved view]{.ui} with [Open the saved view]{.ui} or [Open the dataset as new]{.ui}.
- [Reset the workspace]{.ui} (button 21) puts view, tools, channels and measurements back to how the dataset opened; the **quality** is not changed.
- The viewer has no "Save" button: the address is the save. The Compare page, however, has [Save]{.ui} / [Restore]{.ui} (§ 12.8).

::: remember
- A measurement is calculated in **µm** on what **you see**; a click in empty space is refused.
- The oblique slice and the Z-stack exclude each other.
- The Studio exports at native resolution; its JSON never contains pixels.
- Compare = the real pages in frames, with a shared memory budget.
- "Isolate the staining" is a visual aid, not a measurement.
:::
