# 20. Appendices

::: chapter-intro
- Five **reference** appendices: to be looked things up in, not read in one go.
- **A**: what is where in the code. **B**: what your browser remembers, and the address parameters. **C**: what Lumen3D does not do.
- **D**: all the important figures in one place, with the chapter that explains each. **E**: the history of the versions.
:::

## 20.A Module map

Lumen3D is written in "plain" JavaScript: no framework, no compilation. Each file has **one role** and a name that says it. This appendix is the index, one file per line.

![Five families of files. Pages orchestrate, viewers draw, the core lends a hand, workers compute.](img-en/ch20/carte-modules.svg){width=100%}

::: analogy
**A restaurant.** The *pages* are the waiters who take your order. The *viewers* are the cooks who draw the dish. The *core* is the pantry, the knives and the work surface. The *workers* are the washing-up, backstage: you do not see it, but nothing would leave the kitchen without it.
:::

### The core: `js/core/` (33 files)

| File | What it does, in plain words | Ch. |
|---|---|---|
| `brick-loader.js` | fetches bricks from the packs, in batches, without downloading the same thing twice | 10 |
| `brick-decode-worker.js` | worker: decodes the WebP images and cuts the mosaics back into bricks | 10 |
| `svr-manager.js` | manages the 3D atlas in graphics memory and its memory budget | 10 |
| `catalog.js` | loads the list of datasets, filters it, searches it, finds related datasets | 3 |
| `utils.js` | common toolbox: the type vocabulary (3d, 2d, live), dates, 1-2-5 scale bars | 1 |
| `tool-manager.js` | knows which tool is active (navigate, slice, measure) and handles keyboard shortcuts | 12 |
| `volume-source-manager.js` | normalises the description of a dataset's "sources" (bricks, time series) | 10 |
| `url-state.js` | writes and reads the view state in the address (`#state=`) | 12 |
| `workspace-state.js` | saves and restores the workspace in the browser | 12 |
| `measurement-store.js` | keeps the distances measured during the session in memory | 12 |
| `export-manager.js` | engine of the Download Center: workspace, measurements, metadata, citation | 12 |
| `display-presets.js` | backgrounds of the 3D display: dark, light, paper, transparent, custom | 9 |
| `slice-compositor.js` | recolours a slice from its raw values, for the Studio | 12 |
| `plane-loader.js` / `plane-codec.js` | read the XY planes of format 2 and define their PNG format | 7, 17 |
| `plugin-registry.js` | discovers, loads and plugs in the plugins; builds the toolbar | 15 |
| `plugin-trust.js` | checks a plugin's fingerprint and trust level | 15 |
| `plugin-sandbox.js` | the cage (isolated iframe) of approved third-party plugins | 15 |
| `compat.js` | says whether a plugin is compatible with the platform version | 15 |
| `i18n.js` | translations: English, French, Spanish, Dutch and added languages | 16 |
| `instance-config.js` | reads the site configuration (name, specimen, texts): the "white label" | 16 |
| `theme.js` / `theme-boot.js` | light/dark switch; `theme-boot` applies it before the first paint | 16 |
| `colorblind.js` | eight colour-blindness simulations, applied to the whole page | 16 |
| `page-renderer.js` | draws a page built in the editor (sections, columns, widgets) | 16 |
| `page-templates.js` | default content of the About page | 16 |
| `page-edit-frame.js` | live editing mode of the page editor | 16 |
| `page-vars.js` | variables in page texts (year, date, number of datasets…) | 16 |
| `page-background.js` | animated backgrounds of built pages | 16 |
| `dialog.js` | small choice windows (Confirm / Cancel); Esc = cancel | 16 |
| `ui-actions.js` | handles clicks on the header buttons (the security policy forbids handlers in the HTML) | 19 |
| `font-loader.js` | switches on the Google fonts without delaying the first paint | 19 |
| `perf-telemetry.js` | diagnostic timers, kept locally, never sent | 10 |

### The viewers: `js/viewers/` (5 files)

| File | What it does, in plain words | Ch. |
|---|---|---|
| `volume-viewer.js` | the heart: the 3D scene, ray marching, the camera, captures | 9 |
| `volume-slicer.js` | computes a plane slice (straight or oblique) in the volume | 12 |
| `volume-grid.js` | reference grid, axes gizmo and 3D scale bar | 12 |
| `tracking-overlay.js` | draws the tracked cells of a time-lapse over the volume | 12 |
| `2d-viewer.js` | draws a 2D photograph (zoom, pan, scale) | 12 |

### The components: `js/components/` (5 files)

| File | What it does, in plain words | Ch. |
|---|---|---|
| `channel-panel.js` | the channel panel: colour, window, gamma, opacity | 11 |
| `decomposition-panel.js` | the "Decompose by channel" interface | 12 |
| `studio-editor.js` | the Studio: annotate and export a figure | 12 |
| `timeline.js` | the time strip and the series player | 12 |
| `dataset-gallery.js` | the gallery of images attached to a dataset, with its enlargement | 12 |

### The workers: `js/workers/` (9 files)

A worker is a background employee: it works without blocking the screen (chapter 2).

| File | What it does, in plain words | Ch. |
|---|---|---|
| `gaussian-blur-worker.js` | Gaussian blur of a channel, plane by plane | 11 |
| `plane-decode-worker.js` | decodes the PNG tiles of the XY planes | 7 |
| `studio-plane-worker.js` / `studio-plane-ops.js` | maximum per channel over a thickness; the pure calculations are in `ops` | 12 |
| `pixel-2d-worker.js` / `pixel-ops-2d.js` | display adjustments and staining isolation of a photograph; pure calculations in `ops` | 12 |
| `tracks-load-worker.js` | prepares the cell-tracking tables (32-bit integers) | 12 |
| `upload-worker.js` | sends the files of an import: reading, fingerprint, sending, retries | 17 |
| `migration-worker.js` | runs the units of a format conversion on the browser side | 17 |

### The pages: `js/pages/` (10 files)

| File | What it does, in plain words | Ch. |
|---|---|---|
| `viewer.js` | the main page: assembles everything for a 3D volume or a series | 3 |
| `2d.js` | the page for 2D photographs | 12 |
| `explorer.js` | the grid of datasets, its filters and the search | 3 |
| `compare.js` | the Compare page: up to four synchronised panels | 12 |
| `compare-policy.js` | chooses each panel's quality so as to fit a shared budget | 12 |
| `landing.js` | the home page | 3 |
| `about.js` / `legal.js` / `page-view.js` | About, Legal, custom pages | 3, 16 |
| `admpan.js` | the administration page (starts the `shell` module) | 14 |

### The administration: `js/pages/admin/` (27 files)

| File | What it does, in plain words | Ch. |
|---|---|---|
| `shell.js` / `shared.js` / `bus.js` | the frame (menu, theme, login), the common tools (requests, messages) and the messaging between tabs | 14 |
| `tab-datasets.js` | the [Datasets]{.ui} tab: list, editor, orientation, gallery | 14 |
| `tab-upload.js`, `upload-manager.js`, `upload-dock.js` | the [Import]{.ui} tab, its orchestrator and the floating badge | 17 |
| `tab-dataset-updates.js`, `migration-runner.js` | [Data updates]{.ui} and its engine (including the request governor) | 17 |
| `tab-dataset-types.js` | [Data types]{.ui}: rename 3d, 2d, live | 16 |
| `tab-branding.js`, `tab-appearance.js`, `tab-legal.js` | [Identity]{.ui}, [Appearance]{.ui}, [Legal]{.ui} | 16 |
| `tab-pages.js` + `pages-controls.js`, `pages-translate.js`, `pages-variables.js` | the page editor and its panels | 16 |
| `tab-plugins.js`, `tab-marketplace.js`, `plugin-update.js` | [Plugins]{.ui}, [Catalog]{.ui} and the common plugin update rule | 15 |
| `tab-updates.js`, `tab-changelog.js`, `markdown.js` | [Updates]{.ui}, the release-notes page, the Markdown reader | 18 |
| `tab-pipeline.js`, `tab-docs.js`, `tab-security.js`, `tab-stats.js` | [Pipeline]{.ui}, [Documentation]{.ui}, [Security]{.ui}, [Statistics]{.ui} | 14 |

### Outside `js/`

| File | What it does, in plain words | Ch. |
|---|---|---|
| `dev_server.py` | the Python server: serves the pages and also does the administration work | 2, 18 |
| `api/*.php` and `router.php` | the twin server in PHP, for hosting without Python | 2, 18 |
| `fast_server.py` | a fast static server, with no administration (performance tests) | 2 |
| `upload_staging.py` | the import engine (allowlist, journal, validation, publication) | 17 |
| `dataset_migrations.py` | the data-format conversions, Python side | 17 |
| `ed25519_pure.py` | Ed25519 signature verifier, in pure Python | 19 |
| `js/migrations/` | the three conversions (`m002`, `m003`, `m004`) on the browser side, and a speed-test block | 17 |
| `js/modules/` | the plugins: `tools/` (toolbar), `channels/` (channel panel), `shaders/` (render modes) | 12, 15 |
| `js/vendor/` | the third-party libraries, hosted locally (Three.js, Lucide, Plotly) | 2 |
| `preprocess/` | the preparation pipeline, in Python | 4 to 8 |
| `tests/`, `tools/` | the test suite (201 files) and the publishing tools | 18 |

## 20.B Browser memories and address parameters {.page}

A browser offers several "drawers" where a site can put small things. Lumen3D uses **four** and never stores study data in them.

![Four places where a piece of information lives.](img-en/ch20/memoires.svg){width=100%}

::: note
Every access to these drawers is protected: in private browsing, or if storage is blocked, the page works, just without memory (chapter 19). Clearing the site data erases everything below without breaking anything.
:::

### B.1 What this browser remembers (`localStorage`)

| Key | What it keeps |
|---|---|
| `iribhm-theme` | the chosen theme, light or dark |
| `iribhm-lang` | the interface language |
| `iribhm-colorblind` | the colour-blindness simulation filter |
| `iribhm.workspace.<scope>.<id>` | the saved workspace of a dataset (camera, channels, tools), as JSON; `<id>` looks like `3d/Dataset-name` |
| `iribhm.viewer.zScale.<id>` | the display stretch in Z, dataset by dataset |
| `iribhm.viewer.playbackFps` | the preferred playback speed for time series (one for the whole viewer) |
| `iribhm-gallery-dock` | the state of the gallery: open, wide or reduced to a badge |
| `lumen3d.gpuContextLosses` | the dates of the last graphics-context losses (8 at most): each loss in the week halves the budget |
| `lumen3d.vramBudgetMB` | **operator setting**: imposes a graphics-memory budget, in MB. Never written by the site (chapter 10) |
| `adm-theme`, `adm-sidebar-collapsed` | theme and collapsed menu of the administration panel |
| `adm-upload-dock-size` | size of the import badge |
| `lumen-dupd-ds-executor`, `lumen-dupd-speedtest`, `lumen-dupd-log` | data conversions: executor chosen per dataset, last speed test, log of the last 20 operations |

::: tip
To bring an over-cautious graphics budget (after several context losses) back to normal, delete `lumen3d.gpuContextLosses` in the browser's tools, or wait a week.
:::

### B.2 What this tab remembers (`sessionStorage`) and the cookie

| Name | Role |
|---|---|
| `lumen_visit` | "the visit has already been counted": one visit counter per session, not per page |
| `lumen_view_<id>` | "this dataset's view has already been counted" (administration previews do not count) |
| `lumenWidgetClip` | clipboard of a widget copied in the page editor |
| cookie `admpan_token` | the administration session: 8 hours, invisible to scripts (`HttpOnly`). Visitors do not receive one |

### B.3 Address parameters

They go after `?` (for example `viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2&quality=high`).

| Page | Parameter | Meaning |
|---|---|---|
| `viewer.html`, `2d.html` | `id=<type>/<folder>` | the dataset to open |
| `viewer.html` | `quality=` | `preview` (256), `balanced` (512), `high` (1024), `2048x2048`, `4096x4096` or `native`; the forms `512x512`, `1024x1024`, `low`, `medium` are accepted |
| `viewer.html`, `2d.html` | `hideHeader=true` | "no banner" page: this is how a Compare panel embeds it |
| same | `panelIndex=<n>` | number of the panel in Compare |
| same | `mode=admin` | administration preview: the view is **not** counted in the statistics |
| same | `path=<type>/<folder>` or `staging:<type>/<folder>` | with `mode=admin`: open a dataset not yet published |
| `explorer.html` | `type=3d`, `2d` or `live` | pre-ticks the type filter |
| `compare.html` | `add=<id>` (repeatable) | datasets to put in the panels (four at most) |
| `page.html` | `slug=<name>` | the custom page to display |
| `page.html`, `about.html`, `index.html` | `preview=draft` | shows the draft rather than the published version |
| `page.html` | `edit=1` | editing mode (used inside the page editor) |
| `admpan.html` | `editor=<slug>` | opens the page editor alone on that page |
| `admpan.html` | `changelog=1` | the release-notes page, without the panel |
| all view pages | `#state=…` | **the complete view**, compressed; written by itself when you change something, at most once a second |

::: tech
`#state=` is a JSON compressed (deflate) then written in base64. It can contain camera, channels, tools, measurements and plugin state. Ceilings: 64 KiB written into the address, 2 MiB of text read, 16 MiB once decompressed (protection against "bombs"). A link that is too big or tampered with is ignored. The parameters of a page embedded in Compare are set by Compare itself.
:::

## 20.C What Lumen3D does not do {.page}

A good tool says what it cannot do. Here are the **deliberate** limits, checked in the code.

![Eight things Lumen3D does not do.](img-en/ch20/limites.svg){width=100%}

| Limit | Why, and what to do |
|---|---|
| **No calibrated intensity quantification** | The pipeline brings 12 or 16 bits down to 0–255 between an estimated background and signal; the grey levels shown are **relative** (chapters 5 and 11). To compare intensities between samples, go back to the original Imaris file |
| **4 channels displayed at most** | Volumes are loaded into a four-component texture (red, green, blue, alpha). The pipeline writes all the channels; the viewer draws the first four (chapter 11) |
| **No deconvolution, no flat-field correction** | The pipeline subtracts a background and sets a window; it corrects neither the lens blur (point spread function) nor uneven illumination |
| **No segmentation, no cell detection** | Cell tracking is **read** from the analysis done in Imaris, never recomputed (chapter 8) |
| **No editing of your voxels** | The viewer reads the data and does not modify it; blur, window or gamma are **display** settings. The only change of value is the pipeline's 16 → 8-bit reduction (chapter 6) |
| **No photobleaching compensation** | The pipeline **measures** the level per image, but no viewer setting uses it: a fading series is displayed darker (chapter 5) |
| **Measurements not saved on the server** | They live in memory during the session and in the link or workspace you save (chapter 12) |
| **No region statistics** | Distances, slices, figures: yes. Volume of a structure or mean intensity of a zone: no |
| **A single administration account** | The public has no account; the administrator is unique, protected by a password (chapter 19) |
| **WebGL2 required** | Without 3D textures, bricks cannot be displayed: a message explains it (chapter 19). On a phone, graphics memory limits quality |
| **Inputs: Imaris `.ims` files and TIFF photographs** | Other microscope formats must be converted first; photographs expect the TIFF exported by ImageJ/Fiji from a Leica file (chapter 4) |
| **No 2D image pyramid** | A photograph is a single native WebP file with a preview; the old tiled viewer was removed |

::: warning
"Does not do it" does not mean "does it badly". If your scientific question needs one of these functions, do it in the appropriate analysis tool, then use Lumen3D to **show** the result.
:::

## 20.D Key figures of the platform {.page}

All the important constants, gathered. The last column says where the idea is explained.

### D.1 The data

| Constant | Value | Ch. |
|---|---|---|
| Brick | 64³ useful voxels; 66³ stored with a 1-voxel border (format 4) | 7 |
| Mosaic of a brick | 9 × 8 slices of 66²: a lossless WebP image of 594 × 528 px | 7 |
| Pack | at most 64 bricks or 16 MiB, in super-blocks of 4 × 4 × 4 bricks | 7 |
| Levels of detail | halved in X and Y; in Z only while vz ≤ 1.5 × vxy | 6, 7 |
| Current data format | 4 (formats 1 to 3 are converted in place) | 7, 17 |
| XY plane (format 2) | one file per plane; 512 × 512 PNG tiles | 7, 17 |
| Layer projection (format 3) | one maximum-intensity projection per layer of 64 planes | 7 |
| Maximum size accepted | 2²⁰ voxels per axis; 64 channels at most accepted, **4 displayed** | 19 |
| Depth reduction | 16 or 12 bits → 8 bits (the pipeline's only loss) | 5, 6 |

### D.2 Background cleaning (pipeline)

| Constant | Value | Ch. |
|---|---|---|
| Background floor `bg_floor` | 99th percentile of the 8 corner cubes | 5 |
| Saturation `sig_max` | 99.9th percentile (of one voxel in 4) | 5 |
| Mask threshold | above 1.1 × `bg_floor` | 5 |
| Mask cleaning | opening, then dilation × 3 | 5 |
| Time series | `sig_max` computed only on the voxels above the background, if there are at least 1,000 | 5 |

### D.3 Streaming and graphics memory

| Constant | Value | Ch. |
|---|---|---|
| Simultaneous brick loads | 24 | 10 |
| Simultaneous pack bodies | 4 | 10 |
| Compressed pack memory kept | 192 MiB (packs) · 64 MiB (ranges) · 32 MiB (prefetch) | 10 |
| Look-ahead | 64 MiB ahead of the decoded brick | 10 |
| Time-outs | 30 s without an answer (download) · 30 s (decoding) | 10, 19 |
| Attempts per brick | 3, waiting 0.5 s then 1 s | 19 |
| Worker replacements | 3 at most, then decoding in the page | 19 |
| Quality 512 | finest level whose longest XY side is ≤ 768 voxels | 10 |
| Quality 1024 | same, ≤ 1,536 voxels | 10 |
| Atlas | up to 8 pages | 10 |
| Graphics budget: software rendering | 256 MiB | 10 |
| Graphics budget: integrated card | 0.5 · 1 · 2 GiB depending on the device's memory | 10 |
| Graphics budget: discrete card | 3 or 4 GiB | 10 |
| Graphics budget: unknown | 1 or 2 GiB | 10 |
| Graphics context loss | budget ÷ 2 per loss in the week (floor 256 MiB) | 19 |
| Safeguard | 3 losses within 120 s: no more automatic reload | 19 |
| Compare | 4 panels at most; shared budget 1.5 GiB; 180 s for a panel to settle | 12 |

### D.4 Rendering

| Constant | Value | Ch. |
|---|---|---|
| Samples per ray (at rest) | `clamp(6·10⁹ / pixels, 256, 4096)` | 9 |
| Target frame | 16.7 ms (60 frames/s); we degrade beyond 1.3×, and climb back below 1.1× | 9 |
| Resting frame too slow | beyond 200 ms, the sample ceiling is reduced | 9 |
| Windows safeguard (TDR) | a graphics computation of more than about 2 s resets the card | 9 |

### D.5 Security and access

| Constant | Value | Ch. |
|---|---|---|
| Password | at least 8 characters; PBKDF2-HMAC-SHA256, 600,000 rounds | 19 |
| Login failures | 10 in 15 minutes from one address → 15-minute block; global ceiling of 200 per window | 19 |
| Administration session | 8 hours; closed at every password change | 19 |
| `#state=` link | 64 KiB written · 2 MiB read · 16 MiB decompressed | 12, 20.B |
| A dataset's gallery | 40 images, 8 MiB each | 14 |
| Visit counters | per address: 60 in a burst then 1 per second; global: 600 then 20 per second; 4,096 slots | 19 |

### D.6 Import, conversions and updates

| Constant | Value | Ch. |
|---|---|---|
| Import chunk | 8 MiB (between 256 KiB and 16 MiB); 4 sends in parallel | 17 |
| Attempts per chunk | 6, wait of 1 s doubled up to 30 s; network probe 2 s to 15 s | 19 |
| Import request time-out | at least 60 s (down to 50 KB/s at the floor) | 17 |
| Request governor (conversions) | 6 in flight, 0.5 to 6 per second (starting at 4), pause of 5 s to 60 s | 17 |
| Bricks read per request | 128 | 17 |
| Body of a conversion unit | 32 MiB at most (PHP hosts) | 17 |
| Conversion unit | a layer of 64 planes × one channel × one 512² tile (8 × 8 bricks) | 17 |
| Health probe after update (Python) | about 30 s | 18 |
| Plugins in the signed catalogue | 28 | 15 |
| Test files | 201 (one process per file) | 18 |

## 20.E Versions and history {.page}

The web platform and the preparation pipeline are two pieces of software, with **two independent numbers**. Each version has a note, `changelog/changelog_X.Y.Z.md` for the platform and `preprocess/changelog/` for the pipeline.

![The main milestones of the platform and the pipeline.](img-en/ch20/chronologie.svg){width=100%}

::: note
The platform version exists only in the **name of the latest notes file**: to move to a new version, a note is added. The Python server's version (`dev_server.py`) is a third number, separate and older: it tracks the server tool, not the platform.
:::

### E.1 Web platform

| Version | What it brings |
|---|---|
| 1.3 – 1.4 | Download Center as a file explorer; complete redesign of the administration panel |
| **1.5** | **First public release on GitHub**: safe update by folder swap with rollback, health probe, one-file installer, plugin ↔ platform compatibility |
| 1.6 | Isolation of third-party plugins: trust, sandbox, strict security policy, libraries hosted locally |
| 1.7 | Signed releases (Ed25519), security policy on PHP hosts too, sandbox hardening |
| 1.8 – 1.13 | White label: site configuration, first-run wizard, signed plugin catalogue (1.12), sections → columns → widgets page editor (1.13) |
| 1.14 | Update of PHP hosts (1.14.2) |
| 1.25 | The About page becomes an editable page |
| 1.31 | Cell tracking is finally drawn in the viewer |
| 1.43 – 1.44 | Import of a dataset from the browser, in tiers and resumable; Pipeline pack downloadable like a release |
| 1.45 – 1.49 | Image gallery per dataset; 2D photograph viewer (1.47) |
| 1.51 | A single type vocabulary: `3d`, `2d`, `live` |
| 1.53 – 1.54 | Cell tracking becomes a layer of a series (1.53); Compare drives the real pages (1.54) |
| 1.55 – 1.56 | Camera poses and Z-stack browser; 3D view export, annotation rotation, channel recolouring in the Studio |
| **1.57** | "Audit wave": streaming rewritten in batches, graphics-memory budget, signed release and mandatory test suite at every publication |
| **1.58** | Data updates: in-place conversion of a dataset to format 2 |
| **1.59** | Formats 3 and 4 (v3 bricks with border, `index.bin`, detail on zoom); executor chosen per dataset and speed test (1.59.1); request governor (1.59.2); eight times fewer requests (1.59.3) |

### E.2 Preparation pipeline

| Version | What it brings |
|---|---|
| 0.12 – 0.13 | Otsu threshold abandoned (0.12.0); background estimated by corner percentile and mask-based denoising (0.12.13 to 0.13.0) |
| 0.14 | Standalone one-file launcher |
| 0.15 – 0.16 | True 4D series; cell tracking attached automatically |
| 0.17 – 0.18 | Photograph importer; new type vocabulary |
| 0.19 | "All or nothing" publication in a staging area, with recovery after interruption |
| 0.20 | XY planes written directly (format 2) |
| **0.21** | Format 4 written directly, byte-identical to the conversion; exact skipping of empty space |

::: remember
Current version of this document: platform **1.59.3**, pipeline **0.21.0**, data format **4**.
:::
