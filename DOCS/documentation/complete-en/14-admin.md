# 14. The administration panel in brief

::: chapter-intro
- The administration panel is Lumen3D's **engine room**: it is where you put data online, set the look of the site and update the platform.
- It has **15 tabs in 4 groups**. You will only use a few of them day to day.
- This chapter is an **overview**. The step-by-step manual is the "**Administrator guide**", published in the panel's own [Documentation]{.ui} tab.
:::

## 14.1 What the panel is for, and how to reach it

The public site is the shop window: visitors look at embryos. The administration panel is the **back office**. It lets you:

- **put datasets online** and describe them (name, stage, colours, orientation);
- **choose what the public sees** (visible or hidden);
- **customise the site**: name, colours, pages, legal notices;
- **install plugins** and **update the platform**.

::: note
The panel has **no public link**. You open it by typing the address `admpan.html` after the site's address (for example `https://your-site/admpan.html`). It asks for a user name and a password. The password is created on the very first visit, using a 5-step wizard (account, identity, theme, texts, plugins).
:::

## 14.2 The 15 tabs, in 4 groups

The left-hand sidebar arranges the tabs into four groups. The breadcrumb at the top tells you where you are (for example [Data › Datasets]{.ui}).

| Tab | What it does | How often |
|---|---|---|
| **Data** | | |
| [Datasets]{.ui} | List, preview, settings | often |
| [Import]{.ui} | Upload a pipeline folder | for every new dataset |
| [Data updates]{.ui} | Bring datasets to format 4 | rarely |
| [Data types]{.ui} | Rename 3D, 2D, Live | once |
| [Statistics]{.ui} | Visits, views, downloads | occasionally |
| **Public site** | | |
| [Identity]{.ui} | Name, vocabulary, SEO, menu | at installation |
| [Appearance]{.ui} | Colours, font, rounding | at installation |
| [Pages]{.ui} | Visual page editor | sometimes |
| [Legal]{.ui} | Legal texts, per language | once |
| **Extensions** | | |
| [Plugins]{.ui} | Enable, approve | sometimes |
| [Catalog]{.ui} | Install signed plugins | sometimes |
| **System** | | |
| [Updates]{.ui} | Update the platform | regularly |
| [Pipeline]{.ui} | Download the pack (ch. 4 to 8) | for every new pack |
| [Security]{.ui} | Password, permissions | rarely |
| [Documentation]{.ui} | Read the published guides | on demand |

:::: cols-wide-right
::: col
![The panel's sidebar (demo dataset).](img-en/ch14/admin-overview.png){.shot width=100%}
:::
::: col
- [1]{.callout-num} [Data]{.ui} group: the datasets
- [2]{.callout-num} [Public site]{.ui} group: appearance and texts seen by visitors
- [3]{.callout-num} [Extensions]{.ui} group: plugins
- [4]{.callout-num} [System]{.ui} group: updates, security, documentation
- [5]{.callout-num} Breadcrumb: group, then current tab
- [6]{.callout-num} Link to the public site (new tab)

At the top right: light/dark theme of the panel, language (French, English, Spanish, Dutch) and log out.
:::
::::

::: remember
Two tabs start with "Updates": [Data updates]{.ui} (Data group: bring **your datasets** to the current format) and [Updates]{.ui} (System group: update **the platform**). Do not confuse them.
:::

::: tip
An orange "Unsaved changes" badge lights up at the top as soon as a tab holds changes that have not been saved yet. <kbd>Ctrl</kbd>+<kbd>S</kbd> saves the visible tab (Datasets, Data types, Identity, Appearance, Legal).
:::


## 14.3 Putting a dataset online

The pipeline (chapters 4 to 8) produces **one folder**. There are two ways to put it on the server.

![Two paths to put a dataset online.](img-en/ch14/flux-dataset.svg){width=100%}

::: example
**Route A**: you copy the folder into `DATA_WEB/3d/` by FTP. The dataset appears straight away: the catalogue is recomputed on every request from the `metadata.json` files, so there is nothing to regenerate.
:::

### The Import tab, step by step

![The Import tab, before any transfer (demo dataset).](img-en/ch14/admin-import.png){.shot width=66%}

[1]{.callout-num} Drop zone: drag the folder or click [Choose a folder]{.ui} · [2]{.callout-num} Reminder: transit through a private folder, only the expected files are accepted

Once a transfer is running, a card appears under the drop zone. It shows the overall progress (percentage, volume transferred, speed, time remaining), the dataset's state (see below) and the buttons [Edit]{.ui}, [Verify]{.ui}, [Publish]{.ui} and [Delete]{.ui}, depending on that state.

The states of a dataset being imported:

| State shown | What it means |
|---|---|
| [Uploading — not editable]{.pill .amber} | the files essential for opening it are not all there yet |
| [Uploading — editable]{.pill .blue} | can be opened at low resolution: rename it and set the channels while the rest arrives |
| [Uploaded — ready to publish]{.pill .green} | transfer complete and verified; it only remains to publish |
| [Interrupted]{.pill .grey} | drag the same folder in again to resume; without a resume, it is purged after 7 days |

::: analogy
**A move by shuttle truck.** The folder leaves in small numbered boxes (8 MiB blocks) bound for a private warehouse. If the truck breaks down, we restart from the last box delivered. The most useful boxes (the card, the map, the coarse view) go first: you can start decorating before everything has arrived.
:::

::: warning
A dataset published by Import is **hidden by default**. Go to [Datasets]{.ui}, then turn on the eye (or the [Visibility]{.ui} switch) to show it to the public.
:::


## 14.4 Editing a dataset

Click a dataset in the [Datasets]{.ui} tab's list: the preview opens in the centre, the settings on the right. Here is what you can set there:

| Section | What you decide there |
|---|---|
| [Visibility]{.ui} | visible or hidden in the explorer (**applied immediately**) |
| [Identification]{.ui} | display name, stage, embryo, description |
| [Image gallery]{.ui} | up to 40 images (8 MB max) with captions, shown in the viewer |
| [Physical calibration]{.ui} | voxel size X, Y, Z in µm |
| [Display settings]{.ui} | default exposure |
| [3D orientation]{.ui} | sample side, reference frame, displayed axes, default view |
| Channels (in the preview) | name, colour, min, max, gamma of each channel |

::: remember
What the editor saves is a **setting**: it is merged into the dataset's `metadata.json`. The panel never touches the pixels of the native level. The camera position, the render mode or the slice plane are not kept: they belong to the visitor.
:::

The [Reset the preview]{.ui} button (under the preview) makes the current view the explorer's thumbnail. The 3D orientation (axes, default view) is explained in chapter 12.

## 14.5 Data updates

The way datasets are stored has evolved four times (**formats 1 to 4**, see chapter 7). An old dataset remains readable, but it can be **brought to the current format without going through the pipeline again**, like updating software.

![The three updates, the two executors, the speed test.](img-en/ch14/migrations.svg){width=100%}

The three steps add: `planes/` (one file per plane, fast native XY slices in the Studio), `mips/` (maximum projection of each layer of 64 planes, fast z-stack figures), then a v3 brick pyramid (66³, one-voxel border, `index.bin`).

::: why
The native level is kept voxel for voxel: nothing is lost. The old `bricks/` tree is deleted only after the dataset's version has changed. A dataset produced by pipeline 0.21.0 is **already** in format 4: there is nothing to do.
:::

![The Data updates tab (demo dataset, before launch).](img-en/ch14/admin-dataset-updates.png){.shot width=66%}

[1]{.callout-num} [2]{.callout-num} Speed test: [Run the test (5 s)]{.ui} compares browser and server · [3]{.callout-num} Choice of executor, dataset by dataset (locked while running) · [4]{.callout-num} [Update]{.ui} this dataset · [5]{.callout-num} [Update all]{.ui}: processes every dataset that is ready

::: warning
**Keep the tab open** during an update. Leaving it pauses the update; nothing is lost, you resume later. Do not open several tabs at once: a host has already blocked the address of an operator who sent too many requests. The tab's network governor limits the rate to avoid this.
:::

These updates are **not mandatory**: the viewer reads formats 1 to 4. They speed up some Studio operations and improve the display.

## 14.6 Plugins and the signed catalogue

Plugins are the viewer's tools (chapter 12). They are **not shipped with the platform**: you install them on demand from the [Catalog]{.ui}, as in an app store.

- The catalogue is **signed**: an unverified plugin is never installed (chapter 19).
- Installation asks for your **password**, then the plugin is installed and approved.
- The [Plugins]{.ui} tab shows three cards (Tools, Channels, Render modes): one switch per plugin and a trust label (`bundled`, `approved`, `sandbox`, `untrusted`…).
- Some plugins do not appear in the Datasets tab's preview, nor in the Compare page: they declare themselves compatible with the full page only. This is not a fault.


## 14.7 Updating the platform

From [System › Updates]{.ui}, a button starts the update. What happens behind the scenes was designed so that **a site is never left broken**.

![The update switch-over and its safety net.](img-en/ch14/mise-a-jour-plateforme.svg){width=100%}

::: analogy
**The blue-green move.** The new flat is set up next to the old one; you check that the water and electricity work, and only then do you move in. If something is wrong, you go back to the old one, which was left untouched.
:::

- The tab shows the **release notes** of every version that will be installed, and checks your plugins beforehand: any that would be incompatible are set aside, then re-enabled later.
- It also shows the version of the **Pipeline pack** ([Pipeline]{.ui} tab): this is a different piece of software, which is installed on the processing workstation, not on the server.

## 14.8 Customising the site (white label)

Lumen3D is not tied to one laboratory: everything the public sees can be set without writing code.

| Tab | What you customise there |
|---|---|
| [Identity]{.ui} | instance name, name of the "specimen" (embryo, organ…), tagline, footer, menu links |
| [Appearance]{.ui} | brand colour, font, rounding, with live preview |
| [Pages]{.ui} | visual editor: sections, columns, widgets; the draft is saved automatically |
| [Legal]{.ui} | text sections, one language at a time |
| [Data types]{.ui} | the **name** given to "3d", "2d" and "live" in badges and filters |

::: note
Renaming a data type changes only the **displayed text**: never the folders, identifiers or addresses. The names of the specimen and of the types adapt automatically throughout the site.
:::

::: see
For the detail of every screen, error messages and special cases, see the "**Administrator guide**" ([Documentation]{.ui} tab). For the panel's security, see chapter 19.
:::
