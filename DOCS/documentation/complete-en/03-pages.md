# 3. A tour of the pages

::: chapter-intro
- The public site has four main pages: **Home**, **Data Explorer**, **Viewer** (3D and Live) and **Compare**, plus the **2D** page and the **About** / **Legal** pages.
- You move from one to another with the top bar or with the buttons on the dataset cards; **the address (URL)** of a page remembers which dataset is open, and even your view.
- Each section below shows a real screenshot (demonstration dataset) with numbered markers.
:::

## 3.1 The map of the pages

![The public pages and their links. Solid arrows are clicks; dotted ones are direct links.](img-en/ch03/carte-navigation.svg){width=95%}

All public pages share the same top bar: the logo, the four links, then three buttons on the right: **language**, **colour-blind filter** and **light/dark theme**.

::: note
The screenshots in this document are in English and in the dark theme. The site name ("IRIBHM — ULB"), the colours and even the texts of the home page are those of the instance that was photographed: another institution may have changed them (chapter 16).
:::

## 3.2 The Home page {.page}

This is the shop window: a welcome message, a few figures and three cards, one per data type.

![The home page (index.html).](img-en/ch03/accueil.png){.shot width=88%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | The navigation bar: Home, Data Explorer, Compare, About. |
| 2 | The title: "Explore Embryos". The word "Embryos" comes from an instance setting. |
| 3 | [Explore Data]{.ui} opens the Explorer; [Learn More]{.ui} opens About. |
| 4 | The counters: datasets, embryos, tracked cells, regions. They are computed from the published catalogue. |
| 5 | The type cards: a click opens the Explorer already filtered (`explorer.html?type=3d`). |
:::

Below, the [Featured Datasets]{.ui} section highlights three datasets chosen automatically (the richest tracking, the deepest volume…). The administrator can replace the whole home page with a page of their own.

## 3.3 The Data Explorer {.page}

The Explorer lists the published datasets. **Hidden** datasets do not appear in it.

![The data explorer (explorer.html).](img-en/ch03/explorateur.png){.shot width=95%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | The search: it looks in the name, description, channel names, stage and embryo. |
| 2 | The [Data Type]{.ui} filter: 3D, Live or 2D. |
| 3 | The [Stage]{.ui} filter: one box per stage present (E8, E8.5, E9…). [Clear filters]{.ui} resets everything. |
| 4 | The sort order (Name, Date, Stage) and the grid / list choice; next to it, the number of results. |
| 5 | A card: thumbnail, type, badges, name, description, stage and date. |
:::

Each card has three actions:

- [View]{.ui} opens the viewer (or the 2D page for a photograph);
- [Compare]{.ui} adds the dataset to the Compare page;
- [Download]{.ui} opens the dataset's download centre (originals and exports, when the administrator has attached them).

::: tip
The badges on a card say a lot: **Web** (can be displayed), **Raw** (original file available for download), **Tracked** (cells tracked), **Linked** (other datasets are attached, for example a photograph of the same embryo).
:::

## 3.4 The 3D viewer {.page}

This is the heart of the platform. Open a 3D dataset: the volume first appears blurry, then sharpens.

![The viewer on a 3D dataset (viewer.html?id=3d/…).](img-en/ch03/viewer-3d.png){.shot width=92%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | **Tools** group: [Navigate]{.ui} (default), [Slice through volume]{.ui}, [Measure distance]{.ui}. |
| 2 | **Export** group: [Download Center]{.ui}, [Screenshot]{.ui}. |
| 3 | **Visuals** group: grid, axes, orientation axes, hide the volume, brick debugging. |
| 4 | **Layouts** group: [Presentation mode]{.ui}, [Decompose by channel]{.ui}, [Z-Stack Browser]{.ui}. |
| 5 | The [Channels]{.ui} panel: one row per channel (checkbox, colour, adjustable histogram). |
| 6 | [Render Quality]{.ui}: 512, 1024 or native. The text below gives the quality actually active. |
| 7 | Four buttons on the volume: centre the sample, reset the view, export the view as PNG, reset the workspace. |
:::

**Moving around**: drag = rotate; <kbd>Shift</kbd> + drag (or right button) = pan; wheel = zoom; two fingers = pan and pinch.

Under the channels, the [Display]{.ui} panel sets the [Render mode]{.ui} (default "Fluorescence"), the [Visibility (exposure)]{.ui} and the [Background]{.ui}. Further down, [Zoom detail]{.ui} loads finer bricks when you zoom in, and [Physical Scale]{.ui} stretches the display along Z.

::: note
The buttons depend on the **plugins installed** on your instance. Chapter 12: each tool; chapter 11: colours and histograms.
:::

::: tip
**Sharing your view.** The browser address soon ends in `#state=…`: it contains camera, channels, active tool and measurements. Copy it, and the person who opens it can use [Open the saved view]{.ui}.
:::

## 3.5 The Live viewer: the timeline

A Live dataset opens in the same page. Two things are added: the **timeline** at the bottom and, if it was tracked, the [Tracking points]{.ui} layer in the channels panel. On a real time-lapse, playback **waits** until the requested time point is loaded: you see finished images, at the speed at which they arrive (chapter 10).

![The viewer on a Live dataset (demonstration dataset with 4 time points, 50 tracked cells). The tools menu is open.](img-en/ch03/viewer-live.png){.shot width=80%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | The tools menu. When the title is long or the window narrow, the groups fold behind the ☰ button. It includes the tracking tools (inspect a cell, distance between cells, charts, trajectories, surface). |
| 2 | The [Tracking points]{.ui} layer: size and opacity of the spheres, mitoses, fusions, colour by region. |
| 3 | Play / pause and speed (in frames per second; each click changes the speed). |
| 4 | The counter: current time point / last time point (numbered from 0). |
| 5 | The time slider; the light band shows the time points already in memory. |
:::

## 3.6 The 2D page {.page}

A stereomicroscope photograph, calibrated in micrometres. No channels and no 3D: you pan, zoom and measure.

![The 2D page (2d.html?id=2d/…).](img-en/ch03/page-2d.png){.shot width=100%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | The toolbar: Navigate, Measure; Studio, download, contact sheet, screenshot; adjust, native 1:1 resolution, isolate the staining; navigation within the collection. |
| 2 | The [Specimen]{.ui} sheet: stage, line, staining, dissection, zoom, pixel size, field of view. |
| 3 | The [Measurements]{.ui} section: clicking two points gives a distance in µm. |
| 4 | The scale bar (here 200 µm), which follows the zoom. |
| 5 | The zoom shown, and the size of a screen pixel in µm. |
:::

- Wheel = zoom, drag = pan, double-click = fit to the screen.
- [Browse the collection]{.ui} opens a contact sheet of all the photographs; ← and → go to the next one.
- The page first shows a light preview, then the native resolution as soon as it is ready.

## 3.7 Compare {.page}

Up to **four panels** side by side. Each panel is a **real viewer** (or a real 2D page) embedded: everything you can do in the viewer, you can do here, and volumes and photographs can be mixed.

![Comparing three embryos (E8.5, E9.5, E10.5: demonstration dataset).](img-en/ch03/comparer.png){.shot width=100%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | [Add Dataset]{.ui}: opens a picker window with search and filters by type. |
| 2 | The shared tools (Navigate, Slice, Measure…): one click applies to all panels. |
| 3 | [Studio]{.ui} (a figure composed from all the panels), [Export]{.ui}, [Save]{.ui} and [Restore]{.ui} the workspace. |
| 4 | [Auto layout]{.ui} (columns, rows, grid) and [Auto quality]{.ui}. |
| 5 | **SYNC**: what is synchronised between panels, [Z-Stack]{.ui}, [Time]{.ui}, [Camera / view]{.ui}, [Channels]{.ui}. Everything is ticked by default. |
| 6 | The buttons specific to a panel (grid, axes, orientation, volume, Z-stack), its settings and its close button. |
| 7 | The name of the panel's dataset. |
:::

- **Camera / view** ticked: rotating one embryo rotates the others, even if they are calibrated differently. For time-lapses of different lengths, the **fraction** of elapsed time is synchronised.
- **Auto quality**: panels open at 512, then go up one by one (up to 1024 for two volumes, 512 beyond) to fit in a shared graphics memory.
- A single volume with several channels? The [Decompose]{.ui} button clones it into one panel per channel.
- The page address (`#state=…`) remembers the panels and their layout: copy it to share the comparison.

## 3.8 About and Legal notice

**About** presents the project. Its default content is a page the administrator can edit (page editor, chapter 16). **Legal** displays the legal text entered in the [Legal]{.ui} tab; the footer link appears only if it is enabled.

![The About page.](img-en/ch03/a-propos.png){.shot width=80%}

::: note
On a fresh installation, the legal notice is a template to complete (organisation name, address, host): these are bracketed fields that the administrator fills in.
:::

Other pages may exist: the administrator can create **custom pages**, opened by `page.html?slug=<name>` and added to the top bar.

## 3.9 The administration: an overview {.page}

The administration lives in `admpan.html` and asks for a password. It is not in the public bar. Here is only what it looks like; the detail is in chapter 14.

![The administration panel, Datasets tab.](img-en/ch03/admin-apercu.png){.shot width=80%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | The menu: four families, **Data**, **Public site**, **Extensions**, **System**. |
| 2 | The list of datasets (published, hidden, being imported) with search and filters. |
| 3 | The preview area of the chosen dataset: the viewer is shown there as visitors will see it. |
| 4 | The theme, the language and the logout. |
:::

## 3.10 The addresses worth knowing

An address (URL) can say everything about a page. The most useful ones:

| Address | Effect |
|---|---|
| `viewer.html?id=3d/<folder>` | opens a 3D volume (same form for `live/…`) |
| `2d.html?id=2d/<folder>` | opens a photograph |
| `explorer.html?type=3d` | Explorer already filtered (`3d`, `live` or `2d`) |
| `compare.html?add=<id>&add=<id>` | Compare with these datasets already in place (4 at most) |
| `…#state=…` | the exact view (camera, channels, tools, measurements): copy it to share |
| `page.html?slug=<name>` | a custom page |

::: warning
The `hideHeader` and `panelIndex` parameters are used by the Compare page to embed pages without their header; do not use them for normal use.
:::

::: tip
**Keyboard shortcuts** (viewer): <kbd>V</kbd> or <kbd>Esc</kbd> Navigate; <kbd>C</kbd> slice; <kbd>M</kbd> measure; <kbd>I</kbd> inspect a cell; <kbd>D</kbd> distance between cells. 2D page: <kbd>F</kbd> fit, <kbd>B</kbd> contact sheet, ← → previous / next photograph.
:::
