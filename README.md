# lumen3D — Light-Based Unified Microscopy Exploration in 3D

[![WebGL2](https://img.shields.io/badge/Render-WebGL2-blue?style=for-the-badge&logo=opengl)](https://www.khronos.org/webgl/)
[![Three.js](https://img.shields.io/badge/3D%20Engine-Three.js%20(self--hosted)-000000?style=for-the-badge&logo=three.js)](https://threejs.org/)
[![Python](https://img.shields.io/badge/Preprocessing-Python%203.10%2B-3776AB?style=for-the-badge&logo=python)](https://www.python.org/)
[![Offline](https://img.shields.io/badge/Runtime-Offline--capable%20%2F%20No%20CDN-success?style=for-the-badge)](#-security--offline)
[![License](https://img.shields.io/badge/License-PolyForm%20Noncommercial-green?style=for-the-badge)](LICENCE)
[![Languages](https://img.shields.io/badge/i18n-en%20%7C%20fr%20%7C%20es%20%7C%20nl-brightgreen?style=for-the-badge)](#-internationalization-i18n)

**lumen3D** is a high-performance, **white-label** web platform for interactive exploration of multi-gigabyte 3D and 4D biological microscopy datasets. It streams and renders massive confocal volumes directly in the browser at **60 FPS** — no desktop software, no high-end local workstation required. A dataset is one of three kinds: `3d` (a still volume), `2d` (a calibrated stereomicroscope photograph) or `live` (a 4D timelapse — optionally carrying the cell tracking of its cells, drawn and analysed inside the same viewer).

It was designed and built by **Morgan CLIMENT**, originally for the **IRIBHM** (Institut de Recherche Interdisciplinaire en Biologie Humaine et Moléculaire) at the **Université Libre de Bruxelles (ULB)** — the reference deployment, imaging mouse embryos — and has since been **decoupled from that domain** into a reusable product: brand, texts, theme, pages, legal notices, navigation, and the installed plugin set are all configured **no-code** from an admin panel, with neutral defaults out of the box.

The platform bridges raw scientific data and seamless web exploration through a **Python preprocessing pipeline** (Imaris `.ims` → brick-packed LOD pyramids, 3D **and 4D**) and a **vanilla-JS / Three.js client** with a custom WebGL2 ray-marcher and sparse 3D atlas streaming. It is **offline-capable** (all JS libraries self-hosted, no CDN) and ships with a **signed self-updater**, a **signed plugin marketplace** and in-place **data updates** that upgrade published datasets to newer storage formats.

> **Current versions** — Web platform `1.66.0` · Preprocessing tool `0.22.0`.
> The web version is defined solely by the newest `changelog/changelog_X.Y.Z.md` (there is **no** source `__version__` constant for the platform); the preprocessing tool tracks its own `__version__` in `preprocess/run_preprocess.py`.

---

## 🌟 Key Features

### 1. High-Fidelity 3D Volume Rendering
*   **WebGL2 Ray-Marching**: Custom volume shader built on **Three.js**, with multi-channel composition (up to 4+ channels) and per-channel LUT, min/max, gamma, and opacity controls. Render modes (fluorescence, natural fluorescence, structural DVR) are plugins in the shader dropdown.
*   **Sparse Volume Renderer (SVR)**: A 3D-texture atlas manager (`js/core/svr-manager.js`) plans every atlas against a VRAM budget **before** any texture exists (`SVRManager.planAtlas`). A level that does not fit falls back to the next coarser one with a status message, so the tab degrades instead of crashing. Timelapse frames can also be held on the GPU block-compressed (BC4/BC5, about half a byte per voxel and channel; display only, v1.60.0).
*   **Progressive Level-of-Detail (LOD)**: Instant first paint with low-resolution previews (`512×512`, `1024×1024`), then background streaming of higher-resolution bricks up to `native` quality. Around a region of interest, finer bricks are streamed for the view (region-of-interest detail, on format 4 datasets).
*   **VRAM-proportional allocation**: single-channel volumes are uploaded as `R8` rather than `RGBA8` — a 4× memory saving that is what lets a full 4D series fit in VRAM (v1.28.0). One- and two-channel data get R8/RG8 atlases (v1.59.0).

### 2. Smart Slicing & Volume Navigation
*   **Off-Thread Brick Decoding**: bricks are streamed out of `.bin` packs (whole packs for a level stream, byte ranges for a cut) and decoded off-thread (`createImageBitmap` + un-mosaic) in a worker pool (`js/core/brick-decode-worker.js`), keeping the UI thread reserved for Three.js and DOM. A pack is read progressively: each brick is cut out as soon as its bytes have arrived (v1.60.3).
*   **OME-Zarr export**: the Download Center builds `<folder>.ome.zarr.zip` in the browser from the open dataset's lossless bricks (`js/core/ome-zarr-export.js`, shards encoded in `js/workers/ome-zarr-worker.js`, pure format code in `js/core/ome-zarr.js`): NGFF 0.5 / Zarr v3, `sharding_indexed` shards whose 64³ inner chunks are the bricks, stored ZIP64 archive, saved through `showSaveFilePicker` when available. A timelapse exports the timepoint on screen (v1.66.0).
*   **Brick selection by plane**: a cut through the volume downloads only the bricks it crosses, computed in the slicer's own texture-space geometry (`VolumeSlicer.planeGeometry`), so an oblique plane is never tested against the wrong normal.
*   **Oblique / orthogonal slicing + Z-stack browser**: Extract arbitrary 2D cut planes from the volume (`js/viewers/volume-slicer.js`, `slice-inspector` tool) or step through Z-slices in high resolution (`zstack-browser` tool). Opening the Z-stack browser lays the stack flat, with the sample's upper face toward the camera.
*   **Empty Space Skipping**: a brick with no visible voxel is not stored at preprocessing time (`preprocess/bricks_v3_writer.py`); an absent brick reads as zeros, so the streamed dataset shrinks by orders of magnitude.
*   **Touch navigation (tablet & phone)**: one finger orbits, **two fingers pan and zoom in the same gesture**, with the zoom anchored on the pinched point — what sits between the fingers stays there for the whole gesture. The two-finger gesture takes priority over the active tool, so the volume stays reachable in measure or slice mode (v1.35.0; the same anchored-pinch model was added to the Slice Studio in v1.37.0, where one finger keeps drawing).

### 3. 4D Timelapse & Cell Tracking
*   **Real 4D datasets**: timelapse acquisitions are packed as one self-contained brick tree per timepoint (`bricks/t000/`, `t001/`, …) with per-timepoint empty-space skipping and per-timepoint histograms, and routed to `DATA_WEB/live/`. The viewer drives them from a timeline scrubber.
*   **Render-time stabilization — no voxel is ever resampled**: a timelapse drifts and rotates during acquisition. Because the accompanying tracking stabilization is an exact **rigid** motion, the same transform re-expresses the volume in the stabilized frame. The viewer applies it to the **sampling coordinate in the shader** (`volumeWarp` mat4, `hitBoxWarped()`), so the specimen stays still while the imaged box moves around it — exact, free, and reversible. It is enabled only for datasets whose registration was verified rigid at import (`registration.qcSummary.rigid`); a switch in the Display panel turns it off and on (v1.60.7).
*   **Playback paced by the loader, not by the wall clock**: the playhead freezes while the frame it already asked for is still streaming (`Timeline.setStalled()`), with a 250 ms clock-step clamp and a 15 s stall escape hatch. The transition cube is hidden during a timepoint change, so the previous frame stays on screen at full quality until the atomic swap — no more watching chunks fill in (v1.30.0).
*   **Playback-aware cache, and a real buffer**: eviction is no longer LRU — cyclic playback over a series larger than the cache is the textbook LRU worst case (~0 % hit rate, full re-stream every frame). The victim is now the frame whose *cyclic forward distance* from the playhead is greatest, and the budget is counted **in bytes** rather than in entries, so one native frame no longer evicts the cheap 256/512 ones (v1.33.0). On top of that, **background preloading** fills the buffer without displaying anything, like a video player — measured 30/30 frames buffered at 512 without playing a single frame (v1.34.0).
*   **Tracked-cell overlay**: a dataset carrying a `tracking` block gains a **layer** in the channel sidebar (visibility, colour, µm size, opacity, region legend with counts) — a layer, deliberately not a pseudo-channel, so channel indexing and workspace serialization stay 1:1 with the real channels. Points are instanced spheres scaled in micrometres (not `gl_POINTS`, which is a pixel count, driver-clamped and square), they follow the shader's clipping test exactly, and the `tracks.json` is fetched, gunzipped and packed into typed arrays off-thread (`js/workers/tracks-load-worker.js`) (v1.31.0).
*   **Cell-tracking tools** (v1.53.0): cell tracking is a block of a `live` dataset, not a dataset type. Five plugins read it through the viewer's `ctx.tracking` façade — cell trajectories (trails), the exported surface model inside the volume, an inspect tool (metrics, lineage, neighbours, velocities), population and velocity charts, and a cell-measure tool. They are scoped to timelapses (`dataTypes: ["live"]`) and hide themselves when the dataset carries no tracking block.

### 4. Scientific Studio (Measurement & Analysis)
*   **Calibrated Measurements**: Pick two 3D surface points; the platform converts to physical µm using the dataset's voxel size metadata (`measure-distance` plugin, `js/core/measurement-store.js`).
*   **3D view export**: the 3D view is exported as a PNG at any size, rendered in tiles, with optional transparency (v1.56.0).
*   **Production Slice Studio**: In-viewer figure export (rectangle / line / arrow / distance / scale-bar / text layers, rotatable annotations) for publication-ready slice captures (`js/components/studio-editor.js`), with two-finger navigation on the figure surface (one finger keeps drawing). The Studio's channel controls recolour the slice from its raw channel values (`js/core/slice-compositor.js`). Its native pass streams the full-resolution slice chunk by chunk; axis-aligned, XZ/YZ and oblique cuts read their own cut stores in format 5 (v1.56.0, v1.64.0).
*   **Calibrated 2D photographs** (`2d` datasets, `2d.html`): one stereomicroscope picture per dataset — pan/zoom canvas, an exact 1-2-5 scale bar derived from `pixelSizeUm`, µm distance picks sharing the 3D viewer's measurement contract, stain isolation, and a contact-sheet browser over the whole collection. Its plugins (orientation, calibrated grid, display adjustments, split view, figure panel) opt in through `plugin.json#dataTypes`.
*   **Multi-Panel Compare**: Side-by-side dataset comparison (`compare.html`) — volumes and photographs in the same board, each panel the real viewer page embedded chrome-less and driven by `postMessage`: camera / slicer-plane / z-stack / time / channel sync, photographs linked by physical view (µm per screen pixel), one tool for every panel, the panel-capable plugins (`plugin.json#contexts`) drawn as per-panel buttons, staged render quality planned against one shared memory budget, a dataset picker with search and type filter, workspace save/restore and a Slice Studio over all panels at visual or physical scale.
*   **Workspace Persistence**: Save and restore the full viewer state (camera, channels, tools) per dataset (`js/core/workspace-state.js`, `js/core/export-manager.js`).

### 5. Python Preprocessing Pipeline
*   **Imaris (`.ims`) input**: Reads HDF5-based Imaris files via `h5py` and extracts metadata, dimensions, per-channel calibration, the acquisition clock (real per-frame timestamps, median interval) and the stage-frame physical extent — the frame in which Imaris-derived objects (spots, surfaces, tracks) live, and without which no registration is verifiable.
*   **Scientific Image Processing**: **Corner-sampling percentile background subtraction** (`bg_floor` = 99th percentile of the 8 volume corners, `sig_max` = 99.9th percentile of a subsampled volume), `binary_opening` + `binary_dilation` mask cleanup to kill sensor hot-pixels while preserving the fluorescent fade-out, masked median filtering, window leveling, and per-LOD downscaling (`scipy.ndimage`, `PIL`). *(Otsu thresholding was tried and deliberately removed in v0.12.0.)*
*   **Series-global intensity normalization (4D)**: leveling each frame on its own percentiles makes a series flicker — as the specimen bleaches, a per-frame window re-stretches a dying signal, so apparent brightness stays constant while the real one collapses. Percentiles are pooled over 8 sampled timepoints into a **single window**, so frames darken exactly as much as the specimen does. Photobleaching is *measured and published* (`intensityNormalization.signalLevels`), never baked into the voxels. The single-timepoint path is unchanged, so already-published `3d` datasets reproduce byte-for-byte.
*   **Web-Optimized Brick Format**: the default format 4 (pipeline 0.21.0) stores **66³ bricks** — the 64³ interior plus a one-voxel clamp-to-edge border, so filtering needs no neighbour fetch — as a 9×8 lossless-WebP mosaic of 66² slices. Bricks are packed in whole 4×4×4 super-blocks into `.bin` packs, indexed by `manifest.json` (`iribhm-bricks-v3`) and a binary `index.bin`. Levels halve in X/Y and in Z only while the voxels stay near-isotropic. For 4D, one tree per timepoint. `planes/` (format 2, XY planes for the Studio's native cuts) and `mips/` (per-layer maximum projections for the z-stack view) sit beside the bricks.
*   **Format 5 — resolution × compression matrix** (`--format 5`, pipeline 0.22.0): levels sit at 256·2ᵏ below the native size, plus native; Z is never reduced; each level is an exact integer area average of level 0. Five compression columns per level — lossless `ll`, two bounded quantisers `b2`/`b4` stored as lossless indices with a lookup table, and lossy WebP `q80`/`q50` on 80-pixel slices — so a quality can be chosen per use while lossless access stays available. XY, XZ and YZ plane stores and 32×32×bz cut bricks sit inside the same tree. The engine is one module, `format5.py`, shared by the pipeline and the server-side data update.
*   **Tracking import (step 5)**: `tracking_sources.py` finds the cell-tracking analysis in whichever shape exists — a `.imaris_track` beside the volume, the Spots/Tracks objects embedded in the `.ims` (`Scene8`), or the exported `.xls`/`.xlsx` statistics — and `5-tracking_importer.py` attaches it to a volume: writes `tracks.json` (+ `.gz`), `model.glb`, and a `registration` block in `metadata.json`. `run_preprocess.py` does this automatically for timelapses (`--tracking auto|off|FILE`). The stabilization transform is read as declared or **recovered by orthogonal Procrustes** on raw/stabilized pairs; the fit residual is measured and published (`qcSummary.maxResidualUm` — 1.2 × 10⁻¹² µm on the reference set). A non-rigid fit sets `appliedToVolume: false` and is refused rather than approximated.
*   **Staged, all-or-nothing publish**: a run builds each dataset in a private staging tree and moves it into `DATA_WEB/` in one step — a new dataset in one rename; an existing one with its old pipeline entries set aside first and `metadata.json` replaced last as the commit point. The curation of the published dataset (hidden, orientation, gallery, tracking) is merged into the new metadata, and an interrupted swap is finished or undone on the next run.
*   **False-Color Thumbnails & optional download bundles**: MIP composite WebP thumbnails per dataset; with `--with-downloads`, a per-dataset `download/` folder (`_web.zip`, original `.ims`, calibrated ImageJ/Fiji composite TIFF, per-channel MIP PNGs). See [`preprocess/README.md`](preprocess/README.md).

### 6. Extensible Plugin Architecture + Signed Marketplace
*   **Auto-discovered plugins**: A central `PluginRegistry` (`js/core/plugin-registry.js`) discovers tools, channel controls, and shader render modes at runtime. Adding a plugin means dropping a `js/modules/<placement>/<id>/` folder with `plugin.json` + `index.js` — **auto-discovered at load, no manifest to edit and no build step** (since v1.1.0).
*   **App-store model**: Plugins are **not** bundled in a release; they install on demand from a curated **Ed25519-signed marketplace** (`marketplace/`) via the admin **Catalog** tab. Publish with a single command — `python tools/publish_plugin.py <dir> --push` (see [`marketplace/README.md`](marketplace/README.md)).
*   **One-click plugin updates, from wherever you are looking**: the **Updates**, **Plugins** and **Catalog** tabs all offer the same action, backed by one shared implementation (`js/pages/admin/plugin-update.js`) and one server-side verdict — no tab re-derives "up to date" from version strings. The button appears only when a newer version exists **and** declares itself compatible with the installed platform; blocked updates are *shown with their reason*, not hidden. The swap is safe: the working copy is **set aside, not deleted**, until the new one is installed and re-approved, and any failure after that point restores it (v1.40.0, v1.41.0).
*   **Compatibility gating**: `platformCompat` in `plugin.json` (list/range) is resolved by twin implementations in `js/core/compat.js`, `dev_server.py`, and `api/_admin_lib.php`.
*   **Scoped plugins**: `plugin.json` declares the dataset types it runs on (`dataTypes`: `3d`, `2d`, `live`) and the contexts it copes with (`contexts`: `page`, plus `panel` for a plugin that works when driven from a Compare panel). A plugin without `panel` is not loaded inside an embedded page, and `requires` hides a toolbar button when the dataset lacks the matching block (for example `tracking`).

### 7. White-Label & No-Code Administration
*   **Instance configuration** (`config/`): brand, specimen noun, SEO, footer, and navigation live in a public `config/` store (`instance.json`, `theme.json` → compiled `theme.css`, `pages/<slug>.json`, `legal.json`; neutral defaults under `config/defaults/neutral/`), read by `js/core/instance-config.js`. The document `<head>` / brand is injected server-side via `{{SITE:path|fallback}}` placeholders; i18n interpolates `{brand}` / `{specimen}` tokens.
*   **Fifteen admin tabs** (`admpan.html`, in four categories): **Identity** (branding), **Dataset types** (the public name of each of the three types), **Appearance** (theme editor → live palette/font/radius), **Pages**, **Legal** (→ `legal.html`), **Datasets**, **Data updates** (format migrations), **Import** (browser upload), **Stats**, **Plugins**, **Catalog** (marketplace), **Security**, **Updates**, **Pipeline**, **Documentation**.
*   **Full-page visual editor**: the **Pages** tab opens the *real* page in an iframe as a WYSIWYG surface (real nav, footer and theme) — model *section → column → widget*, **27 widget types**, Content / Style / Advanced panels per widget, draft vs. publish, per-language text, variables, keyboard shortcuts, undo/redo and autosave (`js/core/page-renderer.js`, `js/core/page-edit-frame.js`, `js/pages/admin/tab-pages.js`). The default **About** page is itself an editor document (`js/core/page-templates.js`), so what visitors see and what the operator opens in the editor cannot drift apart. Pages can be exported to and imported from a `.lumen-pages.json` file, validated before any write (v1.61.0).
*   **Dataset import from the browser**: drag the folder the pipeline produced into **Import** and it streams up, resumable and hash-verified, with no SFTP (`upload_staging.py`, PHP twin `api/_upload_lib.php`). Files travel in priority tiers, so a dataset is openable minutes into a long transfer. Nothing reaches the public tree before an explicit publish, and the accepted files are a closed allowlist.
*   **Deletion with a 60-day trash**: a deleted dataset moves to `uploads/trash/` (`dataset_trash.py`, PHP twin `api/_trash_lib.php`) and can be restored, purged, or left to expire after 60 days. The same name can be deleted, re-imported and deleted again; a restore over an existing name offers a free one (v1.62.0).
*   **Image gallery per dataset**: annotated captures and figures attached to a dataset, with captions and ordering kept in `metadata.json`, shown in the viewer's sidebar and in a lightbox (`js/components/dataset-gallery.js`).
*   **Data updates**: published datasets are upgraded in place, the way software is updated. `metadata.json` carries a `formatVersion` (the latest is 5); an ordered registry of migrations (`js/migrations/m002-planes.js` … `m005-matrix.js`, mirrored by `dataset_migrations.py` and `api/_migrations_lib.php`) runs as resumable units either in a browser worker or on the server, chosen per dataset after a short speed test. A dataset's previous brick tree can be kept beside the new one and opened in the viewer (`?bricks=previous`).
*   **Pipeline tab**: ships both processing pipelines as a **self-contained downloadable pack** — the volume pipeline, the Imaris tracking pipeline, a coherent demo dataset for each, and a `RUN.bat` that verifies the pack's own integrity and checks Python + dependencies before starting. Two editions, chosen on one question (does that machine have internet access?): *light* (~3 MB, served by the host, creates an isolated `.runtime\venv` rather than installing into the user's Python) and *complete* (~70 MB with a pre-installed runtime, attached to the GitHub release and fetched from there). **The pack carries the preprocessing version, not the platform's** (`lumen3d-pipeline-leger-<pipeline version>.zip`) — it *is* that component; the platform it shipped with stays recorded in its `VERSION.json` for traceability, and the server picks the pack matching the installed platform rather than trusting the filename (v1.32.0, v1.42.0).
*   **Documentation tab**: the document library published in the repository's `DOCS/` folder, readable in-panel and downloadable. Documents are **not** bundled in a release — fixing a guide means dropping a file in `DOCS/`, and every installation sees it on the next load. The filename *is* the metadata: `YYMMDD - IDENTIFIER - LANG.pdf`, where the date versions and sorts, the identifier makes two files the same document, and the language decides what opens (UI language → English → `MULTI` → first available). A file that breaks the rule is reported as ignored rather than silently absorbed (v1.39.0).
*   **Guided first-run setup wizard**: On a fresh install the admin panel runs a 5-step wizard (account → identity → theme → texts → plugin picker) — `js/pages/admin/shell.js`.
*   **Illustrated administrator guide** in **four languages** (FR / EN / NL / ES), each with its own annotated screenshots captured in that language — `DOCS/admin-guide/`, plus one PDF per language and a combined *MULTI* edition opening on a language-choice page with internal links and PDF bookmarks. A full documentation (21 chapters) and an essentials guide are published in FR and EN.

### 8. Deployment, Self-Update & Security
*   **One-file installer** (`install.php`) and a **robust self-updater** (`dev_server.py`): Blue-Green staging swap, health-gated restart, and automatic rollback, driven from the admin **Updates** tab. PHP hosts self-update in one click through a synchronous twin (`api/_admin_lib.php:admin_update_apply_php`).
*   **Signed releases**: CI (`tools/build_release.py`) produces a curated `lumen3d-web-X.Y.Z.zip` + `version.json` + `SHA256SUMS`, Ed25519-signed (`SHA256SUMS.sig`) using a vendored RFC 8032 verifier (`ed25519_pure.py`, stdlib-only). The updater and installer verify **fail-closed** against a pinned publisher key.
*   **Offline & hardened**: see [§ Security & Offline](#-security--offline).

### 9. Zero-Touch Dataset Catalog
Adding a dataset means dropping a folder containing a `metadata.json` — over SFTP, or from the admin panel. **The catalog index is computed per request, never stored** (`api/catalog.php` on PHP hosts, `dev_server.py:_build_catalog` on Python): every field is either copied from the dataset's `metadata.json`, derived from it, or probed from the folder. A persisted copy of a pure projection could only be right by accident — so a dropped dataset shows up on the very next request, and a removed one disappears the same way, with no "regenerate" step and no cache to invalidate. Measured cost: **3.6–6.7 ms** for 16 datasets (v1.27.0).

---

## 🏗️ Technical Architecture

The architecture splits into **Data Preprocessing** (Python, offline) and **Visual Client** (vanilla JS + Three.js, in the browser), served by a Python dev server (`dev_server.py`) with a PHP twin (`api/*.php`) for legacy hosts.

```mermaid
graph TD
    subgraph Preprocessing Pipeline [Offline]
        A[Raw File: .ims] --> B(1-ims_metadata.py)
        A --> C(2-image_processor.py)
        B -->|meta.json + clock + extent| C
        C -->|LOD volumes| D(3-chunk_packer.py)
        C -->|MIP composite| E[thumbnail.webp]
        D -->|66³ bricks + index.bin + manifest.json| F["bricks/lodN — or bricks/tNNN, one tree per timepoint"]
        D --> G(4-catalog_generator.py)
        G -->|per-dataset| H[metadata.json]
        A -.->|Scene8 Spots/Tracks| S(tracking_sources.py)
        T[".imaris_track — or .xls/.xlsx beside the volume"] --> S
        S --> U(5-tracking_importer.py)
        U -->|tracks.json + registration| H
    end

    subgraph Server
        H --> I["catalog computed per request — api/catalog.php or _build_catalog"]
        M["Data updates — dataset_migrations.py / api/migrations.php"] -.->|formatVersion| H
    end

    subgraph Client [Browser - WebGL2]
        I --> J[Catalog.js]
        J --> K[VolumeSourceManager]
        F --> L["BrickLoader — pack-major batches under byte budgets"]
        L --> N[brick-decode-worker pool - WebP decode]
        N --> O[SVRManager - 3D Atlas]
        O --> P["VolumeViewer - Three.js Ray-March + volumeWarp 4D stabilization"]
        P --> Q[WebGL2 Canvas]
        H -->|tracks.json| V[tracks-load-worker]
        V --> W[Cell-tracking layer and tools]
        W --> P
        R[PluginRegistry] --> P
        S2[InstanceConfig - config/] --> P
    end
```

---

## 📂 Codebase Organization

```
├── api/                       # Auth + dataset/site CRUD (PHP legacy; dev_server.py re-implements these routes)
│   ├── auth.php               # Login/setup/logout/session (PBKDF2 admin credential, per-IP lockout)
│   ├── catalog.php            # Dataset index COMPUTED per request (nothing stored on disk)
│   ├── datasets.php           # Dataset metadata read/write (auth before dispatch, CSRF bound to the action)
│   ├── upload.php             # Browser import (resumable, hash-verified)
│   ├── site.php               # White-label config persistence (instance/theme/pages/legal)
│   ├── page-drafts/           # Unpublished page drafts — 0600, denied by 3 independent mechanisms
│   ├── ca-bundle.pem          # Shipped CA store, last-resort fallback for hosts with a broken trust store
│   └── _admin_lib.php         # Shared admin helpers (compat, marketplace, trust, PHP self-update, pipeline)
│                              #   + _upload_lib.php, _migrations_lib.php, _trash_lib.php (PHP twins)
│                              #   NOTE: api/admin_credential.json (PBKDF2 hash) is gitignored + never served
├── config/                    # PUBLIC white-label store (read by js/core/instance-config.js)
│   ├── instance.json          # Brand, specimen noun, SEO, footer, navigation, dataset-type names
│   ├── theme.json → theme.css # Palette/font/radius, server-compiled to CSS
│   ├── pages/<slug>.json      # Custom-page layouts (block builder)
│   ├── legal.json             # Legal notices
│   └── defaults/neutral/      # Neutral, domain-agnostic defaults
├── marketplace/               # Ed25519-SIGNED plugin catalog (app-store); plugins install on demand
├── changelog/                 # Web platform versions — [ADDED]/[OPTIMIZED]/[FIXED]/[CHANGED] (English since 1.55.0)
│   └── archive/               # Older lines (≤ 1.2.x + all 0.x); excluded from version computation
├── css/                       # Stylesheets (variables → themes → base → components → layout → page → tools)
├── js/                        # Frontend (vanilla JS, no bundler, IIFE singletons)
│   ├── components/            # UI panels (channel-panel, timeline, studio-editor, dataset-gallery, ...)
│   ├── core/                  # Engines & stores (plugin-registry, svr-manager, brick-loader, catalog,
│   │                          #   i18n, instance-config, page-renderer, compat, plugin-trust, plugin-sandbox,
│   │                          #   cut-store, data-access, bc-codec, slice-compositor, ...)
│   ├── migrations/            # Data-update handlers, one per format step (m002 … m005) + speedtest-brick.webp
│   ├── modules/               # Plugin tree: tools/ | channels/ | shaders/ (each: plugin.json + index.js)
│   ├── pages/                 # Per-page controllers (viewer.js is the main one)
│   │   └── admin/             # Admin SPA — 15 ESM tabs (datasets, dataset-types, dataset-updates, upload,
│   │                          #   stats, plugins, security, updates, branding, pages, appearance, legal,
│   │                          #   marketplace, pipeline, docs) + shell.js wizard + plugin-update.js,
│   │                          #   dataset-trash.js, migration-runner.js (shared mechanics)
│   ├── vendor/                # SELF-HOSTED libs w/ SRI (Three.js, Lucide, Plotly) — no CDN
│   ├── viewers/               # Renderers (volume-viewer, volume-slicer, volume-grid, tracking-overlay
│   │                          #   — Three.js; 2d-viewer — plain canvas)
│   └── workers/               # Web Workers (gaussian-blur, tracks-load, upload, migration, studio-plane, pixel-2d)
├── lang/                      # Translation bundles (en/fr/es/nl.json) — drop-in discoverable
├── preprocess/                # Python pipeline (see preprocess/README.md)
│   ├── 1-ims_metadata.py      # Imaris metadata extractor (h5py) — dims, calibration, clock, stage extent
│   ├── 2-image_processor.py   # Corner-sampling percentile bg subtraction + masked median (scipy),
│   │                          #   series-global intensity window on 4D
│   ├── 3-chunk_packer.py      # Bricks + packs (format 4 by default; writers: bricks_v3_writer.py,
│   │                          #   planes_writer.py, mips_writer.py); one tree per timepoint
│   ├── 4-catalog_generator.py # metadata.json (+ per-timepoint histograms on 4D)
│   ├── 5-tracking_importer.py # tracking → tracks.json + model.glb + registration block
│   ├── tracking_sources.py    # Finds the tracking: .imaris_track, the .ims Scene8 objects, or .xls/.xlsx
│   ├── 2d_importer.py         # Standalone: one ImageJ/Leica TIFF → one DATA_WEB/2d/<name>/ dataset
│   ├── run_preprocess.py      # Unified runner (orchestrates 1 → 5, --format 4|5, routes 4D to live/, download bundles)
│   ├── requirements.txt       # Python dependencies (h5py, numpy, scipy, Pillow, tqdm)
│   └── changelog/             # Preprocessing tool versions (0.11.x → 0.22.0)
├── SCRIPTS/                   # Imaris tracking-analysis scripts (shipped in the Pipeline pack)
├── tools/                     # build_release.py, build_pipeline_bundle.py, convert_dataset.py (local format-5
│                              #   conversion), bench_brick_codecs.py, publish_plugin.py, gen_signing_key.py,
│                              #   check_version.py, ...
├── DOCS/                      # Published document library (served by the admin Documentation tab)
│   ├── admin-guide/           # Illustrated admin guide — FR/EN/NL/ES + screenshot sets + PDFs
│   └── update-system/ plugin-sandbox/ whitelabel/ plugins/ dataset-migrations/    # Design specs
├── DATA_WEB/                  # Generated dataset bundles (gitignored) — NO stored catalog.json
│   ├── 3d/<dataset>/{metadata.json, thumbnail.webp, bricks/, download/(optional)}
│   ├── 2d/<dataset>/          # ONE calibrated photograph — image.webp + preview.webp, no bricks/
│   ├── live/<dataset>/        # 4D timelapse — bricks/tNNN/ per timepoint (+ tracks.json when tracked)
├── page.html / legal.html     # White-label custom pages + legal notices renderer
├── admpan.html                # Admin panel (ESM entry — the one carve-out from the no-ESM rule)
├── format5.py                 # Format-5 engine (resolution × compression matrix), shared by the pipeline and the data update
├── dataset_migrations.py      # Data-update engine (format migrations), server executor
├── upload_staging.py          # Browser-import engine (closed allowlist, staging, publish)
├── dataset_trash.py           # 60-day trash of deleted datasets
├── install.php                # One-file installer (signature-verified)
├── ed25519_pure.py            # Vendored RFC 8032 Ed25519 verify/sign (stdlib-only)
├── dev_server.py              # Recommended dev server (static + Python-native API + self-updater)
├── fast_server.py             # Multi-threaded no-cache static server (no API)
├── LICENCE                    # PolyForm Noncommercial License 1.0.0
└── README.md
```

---

## ⚡ Quick Start

### 1. Run the Web Client

Requires **Python 3.10+** for the dev server (handles static files, the admin API, and the self-updater).

```bash
python dev_server.py --port 8080
```

Then open <http://localhost:8080>.

On a development checkout, run it with `--dev-trust-local` (`start_dev.bat` and `.claude/launch.json` already do): without that flag, local plugins are untrusted and are not loaded. Production hosts trust the plugins installed from the marketplace and are not affected.

`fast_server.py` and `start.bat` are static-only fallbacks (no admin API) useful for perf tests. `fast_server.py` binds **loopback by default** since v1.29.0 — pass an explicit host as its second argument to expose it deliberately.

### 2. Deploy on a Shared PHP Host (`install.php`)

For hosting without Python, drop the single file [`install.php`](install.php) into an **empty web directory** and open it in a browser. The wizard checks the environment, downloads the latest release from GitHub, verifies it (sha256 + Ed25519 when a publisher key is pinned), extracts it safely, and creates the admin account — then self-locks. Nothing is written before the archive is verified, and every step is resumable.

#### Troubleshooting — "Cannot reach the GitHub API" on a host that *is* online

**Symptom.** The requirements screen passes every row but the last banner reads *"Cannot reach the GitHub API. Check the server's outbound connectivity."* The detail line underneath shows `error setting certificate file: /usr/share/php/cacert.pem` (or a bare `network`).

**Cause.** The host's `php.ini` sets `curl.cainfo` (and/or `openssl.cafile`) to a CA bundle that was **never installed**. cURL then aborts *before opening the socket*, so every outbound HTTPS call from PHP fails — the network itself is fine. An `open_basedir` that hides `/etc/ssl` from PHP produces the same dead end, because the system bundle becomes unreadable too.

**Automatic repair — nothing to do** (since web v1.23.0). The installer detects an unusable trust store and hands cURL/OpenSSL a real bundle, searched in this order:

1. `cacert.pem` next to `install.php` — the operator override, if you want to pin your own;
2. the distribution locations (`/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, `/etc/ssl/ca-bundle.pem`, `/etc/ssl/cert.pem`, …);
3. **its own embedded copy of the Mozilla bundle**, written to `.lumen-ca-seed.pem` — so a host with nothing usable still installs, with no manual step.

**Peer verification is never disabled** at any point. The *CA certificates* row in the requirements list shows which store was selected.

The platform then carries the same bundle at **`api/ca-bundle.pem`**, shipped in every release and refreshed by every update, and uses it as the same last-resort fallback. So the **marketplace** and **one-click updates** keep working on such a host without the operator having to keep any file around — deleting `cacert.pem` is harmless from v1.23.0 on. (On v1.22.x it was not: `cacert.pem` was the only store, and removing it broke update checks.)

If the *CA certificates* row still reads `?`, the installer could not write its bundle — the directory is read-only. Fix the write permission, or upload <https://curl.se/ca/cacert.pem> as `cacert.pem` next to `install.php`.

*Same failure on the Python server?* It does not apply: `dev_server.py` uses the system trust store through Python, not `php.ini`.

#### Files created by the platform must stay editable over FTP/SFTP

On many shared hosts, PHP runs as a **different system user** (`www-data`, `apache`, a php-fpm pool) than the FTP/SFTP account. Everything the installer and the admin panel create then belongs to *that* user — and since POSIX takes the right to delete a file from its **parent directory**, the account can neither upload into those directories nor remove anything inside them. A freshly installed `DATA_WEB/3d/` looks untouchable.

Since web v1.24.0 the platform **inherits the mode of the web root** for everything it creates: directories get the root's mode (with `u+rwx` guaranteed), files get the same minus the execute bits. The root is what the hosting account was set up with, so it already encodes how the site is shared — `0770` (PHP and the SFTP login being different users of the same group, the common shared-hosting layout) yields `0770` / `0660`, `0755` stays `0755` / `0644`. World-writable `0777` / `0666` is used only in the one case inheritance cannot cover: a root writable by nobody but its owner while PHP is not that owner. Secrets (`api/*.json`) always keep `0600`; deleting them only needs the parent directory. Both modes can be forced with the `LUMEN_DIR_MODE` / `LUMEN_FILE_MODE` environment variables.

- **Installed before v1.23.0?** Admin panel → **Security** → *File permissions* → **Repair permissions**. The card also shows which user PHP runs as, who owns the site, and the modes in effect.
- **What the repair touches**: every directory and file under the web root, recursively — `DATA_WEB/` and its dataset trees included. Exceptions, by design: symbolic links are skipped (never followed), `api/*.json` secrets keep `0600` (deleting them only needs the parent directory), the web root itself is left alone (it already belongs to the account), and entries already at the target mode are skipped — which makes a second run nearly instant. A large `DATA_WEB` full of brick packs can take a while on the first pass; the time limit is raised to 5 minutes and the walk is capped at 200 000 entries, so re-run it if the report shows the cap was hit.
- **Trade-off**: PHP cannot `chown`/`chgrp` (root only), so the only lever is the mode. Inheriting the root keeps that lever as narrow as the host itself made it — group-shared hosting gets group permissions, not world ones. World-writable remains possible in the single case above; the clean fix there is asking the host to run PHP as the site account (suEXEC / dedicated pool).
- Datasets go into `DATA_WEB/<type>/<name>/` — that is the whole procedure. Since v1.27.0 the catalog is **computed per request**, so a folder dropped by SFTP shows up on the next page load; there is nothing to regenerate and no `catalog.json` to hand-edit. (The former *Rebuild catalog* button was removed for exactly that reason — it wrote a file nobody reads any more, and kept alive the idea that a manual step was still needed.)

### 3. First-Run Setup (no default password)

There is **no default admin password**. On a fresh install, open the admin panel (`/admpan.html`) — a **guided setup wizard** walks you through creating the admin account and configuring identity, theme, texts, and the initial plugin set. Credentials are stored as a one-way **salted PBKDF2-HMAC-SHA256** hash in `api/admin_credential.json` (gitignored, never served over HTTP).

Change the password later from the admin **Security** tab (requires the current password), or via an operator override:

```bash
python dev_server.py --set-password
```

### 4. Preprocess Raw Microscopy Datasets

The pipeline currently ingests **Imaris `.ims`** files (HDF5), 3D or 4D. On Windows, the self-contained launcher `preprocess/run_preprocess.bat` needs **nothing pre-installed** (it provisions a local Python + deps) — and the admin **Pipeline** tab serves the same thing as a ready-made pack with a menu-driven `RUN.bat`, both pipelines and a demo dataset for each. For the CLI:

```bash
# 1. Install Python dependencies (recommend a venv or conda env)
pip install -r preprocess/requirements.txt

# 2. Point the runner at a directory of .ims files and the DATA_WEB output root
python preprocess/run_preprocess.py --input /path/to/raw_ims_directory --output ./DATA_WEB

# Optional: process only a subset, and/or also build per-dataset download/ bundles
python preprocess/run_preprocess.py --input /path/to/raw --output ./DATA_WEB --only "*E8*" --with-downloads
```

The unified runner executes: metadata extraction → background subtraction + downscaling → MIP thumbnail → brick packing (format 4 by default; `--format 5` for the resolution × compression matrix) → catalog entry (→ optional download bundle). An acquisition with more than one timepoint is routed to `DATA_WEB/live/` instead of `3d/`, which is what turns on the viewer's timeline. Attaching an Imaris tracking analysis is a fifth step, and is automatic for timelapses:

```bash
python preprocess/5-tracking_importer.py /path/to/analysis.imaris_track ./DATA_WEB/live/<name>
```

Full algorithmic reference: [`preprocess/README.md`](preprocess/README.md).

---

## 🎨 White-Label Configuration

Everything user-facing is configured **without touching code**, from the admin panel, and persisted to the public `config/` store:

| What | Admin tab | Stored in | Rendered by |
|---|---|---|---|
| Brand, specimen noun, SEO, footer, nav | **Identity** | `config/instance.json` | `js/core/instance-config.js` + server `{{SITE:…}}` injection |
| Public name of each dataset type (`3d` / `2d` / `live`) | **Dataset types** | `config/instance.json` → `datasetTypes` | `Utils.datasetTypeLabel()` / `datasetTypeTitle()`, falling back to `types.<id>` in `lang/<code>.json` |
| Palette, font, corner radius | **Appearance** | `config/theme.json` → `config/theme.css` | linked after `themes.css` on every public page |
| Custom pages (full-page visual editor, 27 widgets) | **Pages** | `config/pages/<slug>.json` (drafts in `api/page-drafts/`) | `js/core/page-renderer.js` + `page.html?slug=` |
| Legal notices | **Legal** | `config/legal.json` | `legal.html` |

Neutral, domain-agnostic defaults live under `config/defaults/neutral/`, so a fresh instance is generic until you brand it. Design notes: [`DOCS/whitelabel/PLAN.md`](DOCS/whitelabel/PLAN.md); operator manual: [`DOCS/admin-guide/`](DOCS/admin-guide/).

**Drafts are private.** Published page documents are served statically, so an inline `draft` block would have made "publish" a meaningless privacy boundary — anyone could read unpublished content and, since the editor autosaves about once a second, *watch the operator type* by polling that URL. Drafts now live in `api/page-drafts/<slug>.json`, written `0600` and denied by three independent mechanisms (`api/.htaccess`, `router.php`, the Python static filter); only an authenticated session gets them back. A one-time migration moves pre-split documents at startup, and **never deletes a draft it could not file away** — the public copy is the only extant one (v1.29.0).

---

## 🔒 Security & Offline

The platform assumes **no user auth on the public side** but is defensive by design, and runs **fully offline**:

*   **Self-hosted dependencies, no CDN**: all JS libraries (Three.js `0.147.0`, Lucide `0.344.0`, Plotly `2.27.0`) are vendored under `js/vendor/` and loaded with SRI `integrity` from `'self'`. The only remote dependency is Google Fonts (CSS/fonts). Do **not** re-introduce a CDN `<script src>` — it is blocked by the enforced CSP.
*   **Enforced strict CSP**: a per-request nonce is injected server-side (`dev_server.py:_serve_html`, with PHP/`.htaccess` twins) — `script-src 'self' 'nonce-…'`, `style-src-elem 'self' 'nonce-…'` (no `unsafe-inline`). Inline handlers are replaced by `data-action` delegation (`js/core/ui-actions.js`).
*   **Third-party plugin isolation**: a default-deny **trust gate** (`js/core/plugin-trust.js`) pins operator approval to a content hash; untrusted plugins are excluded from the API. Approved-sandboxed UI plugins run in a null-origin **iframe sandbox** (`js/core/plugin-sandbox.js`) with capability-scoped `postMessage`. The trust vouch travels on a **separate channel** from the plugin's own metadata (`/api/plugins` only, never a static manifest or a `plugin.json`) — otherwise a plugin could grade its own trust level, since the hash cannot help when the vouch and the bytes have the same author (v1.29.0).
*   **Release authenticity**: releases are Ed25519-signed (`SHA256SUMS.sig`) and verified **fail-closed** by both the updater (`dev_server.py`) and the installer (`install.php`) against a pinned publisher key. Updates and installs must be signed; the release CI refuses an unsigned build (v1.57.0).
*   **Static-file lockdown**: the deny list covers `api/`, `secrets/`, `logs/`, `backups/`, `uploads/` and `.git/` consistently across `dev_server.py`, `fast_server.py`, the root `.htaccess` and `router.php` — matched **after** percent-decoding and path normalization, and enforced in `translate_path` itself so no code path can route around it. Staging is never served: an import is read back only through the admin session. `fast_server.py` binds loopback by default (v1.29.0).
*   **Admin API discipline**: authentication runs before dispatch and CSRF is bound to the **action**, not to the HTTP method; every dataset `id` is validated before a path is derived from it; the brute-force lockout is keyed per client address (a global counter was a denial-of-service lever, not a defence); `login` is POST-only so credentials never reach a URL (v1.29.0). Admin sessions last eight hours and end on every password change (v1.57.0).
*   **Data hygiene**: dataset structure is validated on load (dimensions, channel count, manifest integrity); a malformed `metadata.json` is rejected, not partially mounted. Study data is never POSTed to third parties.

Design specs: [`DOCS/update-system/`](DOCS/update-system/), [`DOCS/plugin-sandbox/`](DOCS/plugin-sandbox/).

---

## 🔄 Updates & Releases

*   **In-panel updates**: the admin **Updates** tab drives a health-gated Blue-Green update (staging swap + auto-rollback on failure) implemented in `dev_server.py`, with a synchronous one-request twin for PHP hosts (`api/_admin_lib.php`). Each version an update brings is shown with its own release notes (v1.55.0).
*   **In-panel plugin updates**: the same tab lists plugins with a newer *compatible* version in the signed catalog, one-click each or **Update all** under a single password. Updates that require a newer platform are listed separately with their reason. The **Plugins** and **Catalog** tabs expose the same action (shared `js/pages/admin/plugin-update.js`, module-level lock so two tabs can't swap plugin folders at once). Installed plugins are never marked "incompatible" for a *future* catalog version they don't run.
*   **Data updates** (format migrations of published datasets) are a separate, resumable process with its own tab. They upgrade a dataset in place to a newer storage format and update its `formatVersion`; they never touch the software release. The tab offers a speed test, a choice of executor (browser or server) per dataset, pause, resume and retry, and it keeps the history of what was converted.
*   **Publishing a release**: CI (`.github/workflows/`) runs the full test suite, then `tools/build_release.py` (allowlist → curated zip + `version.json` + `SHA256SUMS`, signed to `SHA256SUMS.sig`) and `tools/check_version.py --tag` (a `vX.Y.Z` tag must equal the newest `changelog/` file). Operational runbook: [`DOCS/update-system/RELEASING.md`](DOCS/update-system/RELEASING.md).
*   **Publishing a plugin**: `python tools/publish_plugin.py <plugin-dir> --push` packages, signs, and pushes to the marketplace catalog in one command.
*   **Publishing a document**: drop a file named `YYMMDD - IDENTIFIER - LANG.pdf` in `DOCS/`. Every installation lists it in the admin **Documentation** tab on the next load — no release, no redeploy.

---

## 📈 Performance & Telemetry

A lightweight runtime probe (`js/core/perf-telemetry.js`, `PerfTelemetry.start/end/event/setContext`) provides in-session instrumentation from `viewer.js`. Tracked KPIs include time-to-first-paint on the preview LOD, sustained framerate during camera rotation, and per-LOD brick load latency. *(The historical `DOCS/perf_baseline_*.json` snapshots have been removed from the repo — regenerate locally if needed.)*

The streaming layer keeps **no decoded-brick cache in JavaScript**: decoded bricks live in the GPU atlas, and compressed packs are held only while a running batch still needs them, under byte budgets — 192 MiB for whole packs, 64 MiB for byte ranges, 32 MiB for prefetch (`js/core/brick-loader.js`). At most four pack bodies are in flight, so the page's own requests never queue behind pack downloads on the browser's six HTTP/1.1 sockets per host. The atlas is sized against a VRAM budget before any allocation (`js/core/svr-manager.js`).

**Volume cache (4D).** A separate byte-budgeted cache (between 128 and 768 MiB) holds decoded timepoints. Eviction is **playback-aware**, not LRU: the victim is the frame whose cyclic forward distance from the playhead is greatest, so what survives is a contiguous buffer *ahead* of the head. Measured on the 30-timepoint reference series: the whole series buffers at 256 and 512, 14/30 frames at native — and the status line states the real capacity instead of drawing a full bar that isn't. Native playback went from a full ~600 ms re-stream per frame to a **147 ms median with a continuous frame sequence** (v1.33.0, v1.34.0).

---

## 🌐 Internationalization (i18n)

Full runtime language switching with no reload. Platform translation bundles live under `lang/`:

* `lang/en.json` (English — the fallback locale)
* `lang/fr.json` (French)
* `lang/es.json` (Spanish)
* `lang/nl.json` (Dutch — added in v1.36.0)

All four are at **full key parity** (2134 keys, identical sets, interpolation tokens preserved), covering the public site and the whole admin panel.

Loaded and indexed dynamically by `js/core/i18n.js` (`I18n.t('dotted.key', {params})`). HTML translates via `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` / `data-i18n-aria` attributes. White-label tokens (`{brand}`, `{specimen}`, …) are interpolated per-locale.

**Drop-in languages.** The set of *selectable* languages is discovered at runtime — `GET /api/languages` → `lang/manifest.json` → embedded default — so dropping `lang/zh.json` adds "🇨🇳 中文" to the switcher with no code edit (display name/flag/RTL come from the `LANG_META` registry in `i18n.js`). The switcher itself is generated by `Utils.populateLanguageMenu()`. Regenerate the static manifest for pure-static hosts with `python tools/gen_lang_manifest.py`.

**Translatable plugins.** Each plugin carries its own `lang/<code>.json` under `js/modules/<placement>/<id>/lang/`, merged into the i18n tree under `plugins.<id>`. In plugin code, call `ctx.i18n.t('key')` (auto-namespaced). Fallback rules:

* A platform locale a plugin does **not** ship falls back to the plugin's **English** (the rest of the UI stays in the active language).
* A locale a plugin ships but the platform does **not** is simply never offered — it cannot be used until the platform also ships `lang/<code>.json`.

List a plugin's shipped locales in its `plugin.json` as `"i18nLanguages": ["en", "fr", …]` (the dev server keeps this in sync by scanning the folder). Toolbar/shader labels resolve `i18nTitle` against the plugin's own dictionary first, then the platform.

---

## 🤝 Contributing

Follow the **autonomous versioning** routine described in [CLAUDE.md](CLAUDE.md). Every substantive change bumps the appropriate component:

* **Plateforme Web** → add a new `changelog/changelog_X.Y.Z.md` (sections `[ADDED]` / `[OPTIMIZED]` / `[FIXED]` / `[CHANGED]`, one `- **Short title**: what changed and why` entry per item; English since v1.55.0). There is **no** source `__version__` constant for the web platform — the version *is* the newest changelog filename (`dev_server.py:__version__` tracks the dev-server tool and has drifted; don't use it as the platform version).
* **Outil de Preprocessing** → bump `preprocess/run_preprocess.py:__version__` and add a `preprocess/changelog/changelog_X.Y.Z.md`.

---

## ⚖️ License

This project is licensed under the **PolyForm Noncommercial License 1.0.0** (see [LICENCE](LICENCE)).

* **Permitted**: non-commercial research, personal study, evaluation, testing, and education.
* For commercial use: contact **Morgan CLIMENT** — [morgan.climent@agroparistech.com](mailto:morgan.climent@agroparistech.com).
