# 1. The platform at a glance

::: chapter-intro
- **Lumen3D** is a website for exploring confocal microscopy images that weigh several gigabytes, in an ordinary browser: nothing to install.
- A stack of ~10 GB fits neither in a browser's memory nor in a graphics card's: the whole platform is designed to load only what the screen shows.
- There are **three types** of dataset (3D, Live, 2D) and a single path from the microscope to the screen, which this chapter walks you through.
:::

## 1.1 What is Lumen3D, and who is it for?

**Lumen3D** (*Light-based Unified Microscopy Exploration in 3D*) was born at the IRIBHM (ULB) to look at mouse embryos. It then became a "white-label" platform: name, colours, pages and vocabulary can be changed from the administration panel, without writing a line of code.

Four kinds of people use it, each with a different share of this document:

:::: {.cards .four}
::: card
#### The biologist
Opens an embryo, adjusts colours, measures, slices, compares, builds a figure.

[chapters 3, 11, 12]{.pill .green}
:::
::: card
#### The technician
Runs the Python **pipeline** that turns the Imaris file into a web folder.

[chapters 4 to 8]{.pill .amber}
:::
::: card
#### The administrator
Imports, publishes, customises the site, updates the platform.

[chapters 14 to 19]{.pill}
:::
::: card
#### The public visitor
Browses the published catalogue and looks, with no account or password.

[chapter 3]{.pill .grey}
:::
::::

::: note
There are **no user accounts**. Only the administration is protected by a password; everything that is published is visible to anyone who has the site's address.
:::

## 1.2 The problem: a file too big for a browser

Take the largest reference dataset of the pipeline: an embryo of **3789 × 3789 × 178 voxels** on **4 channels**. The original Imaris file weighs **14.4 GB**.

::: example
**The calculation.** 3789 × 3789 × 178 = 2,555,460,738 voxels per channel. At 1 byte per voxel: **≈ 2.56 GB per channel**, so **≈ 10.2 GB** for 4 channels. The graphics card, for its part, offers the platform only 0.25 to 4 GB depending on its class.
:::

![Even when reduced to 1 byte per voxel, the stack exceeds the memory of most graphics cards.](img-en/ch01/pourquoi.svg){width=95%}

Three obstacles add up:

- **the network**: at about 5 MB/s, 10 GB takes more than half an hour;
- **the browser's memory**: it is not built to hold gigabytes of image;
- **the graphics card's memory** (VRAM): it does the drawing, and it is small.

::: analogy
**A 50-volume encyclopaedia.** Nobody lays all 50 volumes open on the desk to read one paragraph. You take the index, then open the right volume at the right page. Lumen3D does the same with the image: an index (the *manifest*) and small pieces (the *bricks*) fetched on demand.
:::

The answer comes down to three ideas, detailed in chapters 5 to 10:

::: steps
1. **Reduce**: remove the background noise, switch to 8 bits, make smaller versions of the image (the levels of detail).
2. **Cut up**: cube the image into bricks 64 voxels on a side and store them in a few large files.
3. **Stream**: the browser first downloads the coarse version (an instant picture), then refines only the area you are looking at.
:::

## 1.3 The three dataset types

Every published dataset is of one of these three types. The same word is used as the folder name, as the start of the identifier (for example `3d/Embryo-E95-Em2-Pecam1-Sox2`) and as a filter in the Explorer.

![Three types, three display pages. The names in quotation marks are those the public reads by default.](img-en/ch01/types.svg){width=95%}

::: note
The displayed names ("3D", "Live", "2D") belong to the administrator: they can be renamed in the [Data types]{.ui} tab without touching the folders. In this document we use the default names.
:::

| Type | What the dataset contains | Example from the demonstration set |
|---|---|---|
| 3D | one volume, 1 to 4 channels | `Embryo-E95-Em2-Pecam1-Sox2` (768 × 576 × 112, 3 channels) |
| Live | one volume per time point, with a timeline | `Demo-Lumen3D-E85-Em1-30min-2ch-4tp` (4 time points) |
| 2D | one photograph calibrated in µm | `DLL4xCD1-E95-x3.2-240913-1` (X-gal staining) |

::: why
**Why isn't cell tracking a type?** Because it describes a Live dataset; it does not replace it. The cell positions, their trajectories and the surface are **layers** drawn on top of the volume, and five dedicated tools analyse them (chapter 12). A Live dataset without tracking remains a Live dataset.
:::

::: warning
The datasets in this document are **synthetic demonstration datasets**, made for the occasion: they are not real laboratory data.
:::

## 1.4 The journey of an acquisition

From the specimen to the screen, the data pass through four places.

![From the microscope to the screen, in four steps.](img-en/ch01/parcours.svg){width=100%}

| Step | Who | Typical duration | Chapter |
|---|---|---|---|
| 1. Acquisition | confocal microscope + Imaris software | depends on the specimen | 4 |
| 2. Preparation | technician, Python pipeline on their computer | minutes to hours, only once | 5 to 8 |
| 3. Going online | administrator: import by drag-and-drop or SFTP, then publication | depends on the bandwidth | 14 and 17 |
| 4. Display | anyone, with a browser | a few seconds for the first image | 9 to 12 |

::: remember
The heavy work (cleaning, cutting up) is done **once, offline**. After that, each visitor downloads only pieces: this is what makes exploration smooth.
:::

## 1.5 Key figures

:::: keynums
::: keynum
**3**
data types: 3D, Live, 2D
:::
::: keynum
**64³**
voxels per brick (66³ with border, format 4)
:::
::: keynum
**4**
channels displayed at most
:::
::: keynum
**4**
languages: English, French, Spanish, Dutch
:::
::: keynum
**28**
plugins in the signed catalogue
:::
::: keynum
**≈ 126,000**
lines of code, excluding tests
:::
::: keynum
**512 · 1024 · native**
the three rendering qualities
:::
::: keynum
**201**
automatic test files
:::
::::

A few version landmarks, valid at the date of this document:

- web platform **1.59.3**; preparation pipeline **0.21.0**;
- current data format: [format 4]{.pill .green} (formats 1 to 3 are converted in place, see chapter 17);
- every release is checked by the automatic tests before it is published.

## 1.6 Map of the documentation

This document has **21 chapters**, organised like the data's journey: from the microscope to the screen, then administration, reliability and the appendices. Find your question below.

![Which question, which chapter?](img-en/ch01/carte.svg){width=78%}

| Chapter | Title | For whom |
|---|---|---|
| 1 – 3 | The platform at a glance; the technologies; a tour of the pages | everyone |
| 4 – 8 | From Imaris to the web folder: background, reduction, bricks, metadata and tracking | technician |
| 9 – 11 | 3D rendering, streaming, channels and histograms | biologist, the curious |
| 12 – 13 | The tools one by one, then under the bonnet | biologist |
| 14 | The administration panel in brief | administrator |
| 15 | Plugins, trust and the signed catalogue | administrator |
| 16 | Customising and translating | administrator |
| 17 | Data in depth: files, formats, migrations, import | administrator, technician |
| 18 | Hosting, updating, publishing a release | system administrator |
| 19 | Security and reliability, with the "What happens if…?" table | everyone |
| 20 | Appendices: module map, browser memories, limits, figures, versions | reference |
| 21 | Glossary | everyone |

::: tip
In a hurry? Read the **In 30 seconds** boxes at the start of each chapter: they are enough to tell whether the rest concerns you.
:::
