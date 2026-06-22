# CLAUDE.md — Lumen3D / IRIBHM Microscopy Platform

> **Light-based Unified Microscopy Exploration in 3D** — High-performance browser-based viewer for multi-gigabyte confocal microscopy volumes (mouse embryos, IRIBHM lab @ ULB). 60 FPS streaming, scientific tooling, Python preprocessing pipeline.

**Stack** : Vanilla JS (no framework, IIFE modules), Three.js (UMD via CDN), custom WebGL2 ray-marcher, Python preprocessing (h5py / numpy / scipy / PIL), dev server in Python (`dev_server.py`) — PHP fallback in `api/` for legacy hosts.

**Current versions** : Plateforme Web `1.0.4` (latest changelog `changelog/changelog_1.0.4.md`), Preprocessing `0.12.15` (`preprocess/run_preprocess.py:__version__`). ⚠️ Note: `dev_server.py:__version__` is still `0.12.41` and **drifts from the web platform version** — it tracks the server tool itself, not the platform. The Web platform version lives **only** in the `changelog/` filenames; bump by adding a new `changelog_X.Y.Z.md`.

---

## 1. Operating rules (read first, every time)

### 1.1. Code standard — production-grade, scientific rigor
* **Zero approximation** : no `// TODO`, no placeholder, no mock in the data pipeline. The streaming/parsing path must be final and robust.
* **Algorithmic transparency** : every coordinate transform (matrices), every biological calculation, every shader formula must be explicit and mathematically documented in-code. No "magic" hidden behind helpers when the science matters.
* **Render fallbacks** : if VRAM is exhausted or a brick is corrupted, the viewer must degrade gracefully (lower LOD, drop the brick, surface a status). Never crash the tab. Reference impl : [SVRManager.atlasConfigs](js/core/svr-manager.js) — cascading atlas sizes; [BrickLoader fallback path](js/core/brick-loader.js) — `_supportsWebGL3D` + 2D fallback canvas.

### 1.2. Performance constraints (the file size mandates this)
* **Streaming over loading** : volumes are sliced into 64³ bricks, packed in `.bin` packs with a `manifest.json` per dataset. Never load a full volume in one buffer. See [brick-loader.js](js/core/brick-loader.js), [brick-fetch-worker.js](js/core/brick-fetch-worker.js), [brick-decode-worker.js](js/core/brick-decode-worker.js).
* **GPU memory hygiene** : every `THREE.Texture`/`Geometry`/`Material` must be `.dispose()`'d on dataset switch or tool teardown. The `SVRManager` reuses 3D atlas pages — do not allocate new textures per brick.
* **Main thread inviolable** : heavy work (decode, gaussian blur, parsing) lives in Web Workers (`js/workers/`, `js/core/brick-*-worker.js`). UI thread reserved for Three.js + DOM.

### 1.3. UX rules
* Toolbar should stay sparse — 3D canvas owns the screen. Tools surface in the sidebar or as plugin buttons; group via `plugin.json#group`.
* Long ops (preprocessing, brick loading, quality upgrades) must surface precise progress (% + step name), not a spinner. See `_handleQualityProgress` in [viewer.js](js/pages/viewer.js).

### 1.4. Security (no auth, but defensive)
* Validate dataset structure on load (dimensions, channel count, manifest integrity). A malformed `metadata.json` must be rejected, not partially mounted.
* Never POST study data to third parties. The platform is offline-capable; only CDN deps are Three.js, Lucide icons, Google Fonts.

### 1.5. Autonomous versioning — APPLY ON EVERY CHANGE, NO REMINDER NEEDED
The user expects this to happen silently as part of every edit:

* **SemVer** : `0.Y.Z` until the explicit `1.0.0` order was given (already received — web is now in `1.x`). Bump `Z` on every fix / shader tweak / script change. Bump `Y` every 3–5 minor versions or when integrating a major tool / new rendering engine / new compression algorithm.
* **Component scope** : two independent versioned components.
  * `Plateforme Web` → bump only by creating a new `changelog/changelog_X.Y.Z.md`. There is no single source-of-truth `__version__` constant for the Web platform (the `dev_server.py:__version__` is the dev server's own version, not the platform's — has drifted).
  * `Outil de Preprocessing` → version string in `preprocess/run_preprocess.py:__version__` (and the four step scripts `preprocess/1-…py` → `4-…py` carry their own `__version__` where relevant). Changelogs in `preprocess/changelog/changelog_X.Y.Z.md`.
* **Changelog format** : sections `[ADDED]` (features/tools), `[OPTIMIZED]` (perf, shaders, parsing), `[FIXED]` (bugs). Markdown headings — see `changelog/changelog_0.12.45.md` for the canonical shape.
* **End-of-response notice** : after a versioning bump, append a discreet line, e.g.
  `[Versioning] Plateforme Web → v1.0.2. changelog_1.0.2.md généré.`

---

## 2. Architecture map — where each thing lives

### 2.1. HTML entry points (root)
Each `*.html` at the repo root is a standalone page; its JS controller lives in `js/pages/<page>.js`.

| Page | HTML | JS controller | Purpose |
|---|---|---|---|
| Landing | `index.html` | [landing.js](js/pages/landing.js) | Hero, lab presentation |
| Explorer | `explorer.html` | [explorer.js](js/pages/explorer.js) | Dataset grid/filter/search |
| Viewer | `viewer.html` | [viewer.js](js/pages/viewer.js) | **Main 3D/2D viewer** — heart of the app |
| Compare | `compare.html` | [compare.js](js/pages/compare.js) | Side-by-side panels via iframes of `viewer.html` |
| Tracking | `tracking.html` | [tracking.js](js/pages/tracking.js) | Cell tracking timelapse viewer |
| Admin | `admpan.html` | [admpan.js](js/pages/admpan.js) | Dataset metadata CRUD (auth via `api/`) |
| About | `about.html` | [about.js](js/pages/about.js) | Lab info |
| DeepZoom | `deepzoom.html` | embedded in [components/deepzoom-viewer.js](js/components/deepzoom-viewer.js) | OSD-style 2D pyramid |
| Widgets | `widgets.html` | — | Standalone widget demo |

### 2.2. CSS (`css/`)
Cascade order from [index.html](index.html:22) : `variables.css` → `themes.css` → `base.css` → `components.css` → `layout.css` → per-page (`landing.css` / `explorer.css` / `viewer.css` / `admpan.css`) → `tools.css`.
* **Theme tokens** → [variables.css](css/variables.css), [themes.css](css/themes.css) (light/dark via `data-theme` attr).
* **Tool overlay styles** → [tools.css](css/tools.css).

### 2.3. JS core — singletons under `js/core/`
Loaded as classic `<script>` (no ESM), each exposes a global IIFE.

| Module | Role |
|---|---|
| [catalog.js](js/core/catalog.js) | Loads `DATA_WEB/catalog.json`, exposes `Catalog.getById`, `list`, filters |
| [theme.js](js/core/theme.js) | Theme toggle + `data-theme` attribute, `Theme.onChange` listener |
| [i18n.js](js/core/i18n.js) | Loads `lang/{en,fr,es}.json`, exposes `I18n.t(key)` |
| [utils.js](js/core/utils.js) | Date / stage formatting, math helpers |
| [url-state.js](js/core/url-state.js) | Serializes viewer state into URL params |
| [workspace-state.js](js/core/workspace-state.js) | Save/restore camera + channels + tool state |
| [plugin-registry.js](js/core/plugin-registry.js) | **Module loader** — fetches `plugin.json` + injects `index.js`, dispatches hooks. See §3.1. |
| [tool-manager.js](js/core/tool-manager.js) | Active tool mux (navigate / measure / slice / …) |
| [svr-manager.js](js/core/svr-manager.js) | **Sparse Volume Renderer** — manages 3D texture atlas pages on the GPU, cascading sizes for VRAM resilience |
| [brick-loader.js](js/core/brick-loader.js) | LRU brick cache, fetch coordination, dispatches to workers |
| [brick-fetch-worker.js](js/core/brick-fetch-worker.js) | Worker — HTTP fetch + range slicing of pack files |
| [brick-decode-worker.js](js/core/brick-decode-worker.js) | Worker — gunzip / unmosaic 64³ bricks |
| [volume-source-manager.js](js/core/volume-source-manager.js) | Normalizes per-dataset `volumeSources` (webstack / bricks / live) |
| [annotation-manager.js](js/core/annotation-manager.js) | 3D annotation primitives + persistence |
| [annotation-layer.js → js/components](js/components/annotation-layer.js) | Component layer that renders annotations |
| [measurement-store.js](js/core/measurement-store.js) | Persisted distance measurements per dataset (LocalStorage) |
| [analysis-store.js](js/core/analysis-store.js) | Per-channel analysis results (histograms, decomposition) |
| [aabb-intersector.js](js/core/aabb-intersector.js) | Ray ↔ AABB math for slice plane picking |
| [display-presets.js](js/core/display-presets.js) | Background presets (dark, ortho, paper) |
| [colorblind.js](js/core/colorblind.js) | CB-safe channel palettes |
| [download-manifest.js](js/core/download-manifest.js) | Builds export bundles |
| [export-manager.js](js/core/export-manager.js) | Screenshot / video export glue |
| [perf-telemetry.js](js/core/perf-telemetry.js) | `PerfTelemetry.start/end/event/setContext` — instrumentation calls scattered in `viewer.js`. The historical `DOCS/perf_baseline_*.json` snapshots have been removed from the repo. |

### 2.4. JS viewers — Three.js renderers under `js/viewers/`

| File | Renders |
|---|---|
| [volume-viewer.js](js/viewers/volume-viewer.js) | **Main 3D ray-marcher** — owns scene/camera/renderer, cube material, slice plane, gizmos, measurement sprites |
| [volume-slicer.js](js/viewers/volume-slicer.js) | 2D oblique slice extraction from the volume |
| [volume-grid.js](js/viewers/volume-grid.js) | Multi-slice grid view |
| [tracking-viewer.js](js/viewers/tracking-viewer.js) | Cell tracking timelapse render |

### 2.5. JS components (UI panels) under `js/components/`

| File | Role |
|---|---|
| [channel-panel.js](js/components/channel-panel.js) | Per-channel sidebar (color, gamma, min/max, hosts channel-placement plugins) |
| [chart-studio.js](js/components/chart-studio.js) | Inline chart editor for histograms / analysis |
| [decomposition-panel.js](js/components/decomposition-panel.js) | Channel decomposition UI (decompose-channels tool) |
| [deepzoom-viewer.js](js/components/deepzoom-viewer.js) | DZI pyramid viewer for 2D tiles |
| [studio-editor.js](js/components/studio-editor.js) | Admin panel dataset editor |
| [timeline.js](js/components/timeline.js) | Live timepoint scrubber |
| [annotation-layer.js](js/components/annotation-layer.js) | Renders annotations on top of the canvas |

### 2.6. JS plugin modules — `js/modules/<placement>/<module-id>/`
Plugin pattern : each module has `plugin.json` (metadata) + `index.js` (calls `PluginRegistry.implement(id, {init, activate, …})`). Modules are **auto-discovered** (since v1.1.0) — drop a folder in `js/modules/<placement>/<id>/` and it is detected at load; remove it and it disappears. No manifest to edit. Discovery is hybrid: `PluginRegistry.discover()` tries `GET /api/plugins` (dev_server / PHP) → `js/modules/manifest.json` (static fallback, regenerated by the endpoint or `tools/gen_plugins_manifest.py`) → an embedded core-default list. Toolbar buttons are generated from `plugin.json` by `PluginRegistry.buildToolbarButtons()` (cluster=`group`, `action`/`toggle`→`data-plugin-id`, `tool`→`data-tool` chip; `requires:[…]` gates visibility against `volumeSources`).

**Placements** : `tools/` (toolbar buttons), `channels/` (per-channel sidebar controls), `shaders/` (render mode entries in the dropdown).

| Path | Purpose |
|---|---|
| `tools/toggle-grid` `toggle-axes` `toggle-volume` | Scene visibility toggles |
| `tools/orientation-axes` | **Interactive embryo orientation gizmo** (A/P green, D/V blue, L/R red). Drag to recalibrate; quaternion persisted to `metadata.json`. Hooks into admin panel via `postMessage` (no coupling to `VolumeViewer` internals — see [changelog_1.0.2.md](changelog/changelog_1.0.2.md)). |
| `tools/screenshot` | PNG capture |
| `tools/presentation-mode` | Fullscreen / kiosk mode |
| `tools/save-workspace` `restore-workspace` | Workspace persistence (camera + channels) |
| `tools/download-center` | Export bundles (PNG, slice stacks, metadata) |
| `tools/decompose-channels` | Per-channel decomposition panel |
| `tools/zstack-browser` | Z-stack slice browser overlay |
| `tools/deepzoom-2d` | Switch to 2D DeepZoom mode |
| `tools/slice-inspector` | Oblique slice viewport |
| `tools/measure-distance` | 3D point-pick → calibrated µm distance |
| `shaders/fluorescence` | Default fluorescence ray-march (color × density) |
| `shaders/structure-dvr` | Direct Volume Rendering structural mode |
| `channels/histogram` | Per-channel histogram + min/max sliders |
| `channels/gaussian-filter` | Per-channel real-time gaussian blur (uses [gaussian-blur-worker](js/workers/gaussian-blur-worker.js)) |

### 2.7. Web Workers — `js/workers/`
* [gaussian-blur-worker.js](js/workers/gaussian-blur-worker.js) — separable 3D gaussian for channel filter plugin.
* Brick workers live alongside their loader in `js/core/brick-*-worker.js`.

---

## 3. Critical systems — how they fit together

### 3.1. Plugin Registry flow ([js/core/plugin-registry.js](js/core/plugin-registry.js))
1. `viewer.js` calls `await PluginRegistry.discover('js/modules')` (hybrid endpoint→manifest→embedded) → `await PluginRegistry.loadModules('js/modules', paths)`.
2. Registry fetches each `plugin.json`, validates `placement` matches the directory, then injects `<script src=".../index.js">`.
3. `index.js` calls `PluginRegistry.implement(id, { init, activate, deactivate, … })`.
4. `viewer.js` calls `PluginRegistry.buildToolbarButtons({groups, dataset})` to generate the toolbar from metadata, then `PluginRegistry.initAll(ctx)` (passes the `ViewerContext`), then `PluginRegistry.bindToolbarButtons()` to wire the generated `data-plugin-id` buttons.
5. UI population : tools toolbar / shader dropdown / channel panel all query `PluginRegistry.listByPlacement(...)`, sort by `meta.order`, render from metadata.

**Order matters** : `discover` + `loadModules` are awaited BEFORE any UI is built (toolbar, shader dropdown, channel panel). Regression in v0.12.45 ([changelog_0.12.45.md](changelog/changelog_0.12.45.md)) — keep this invariant.

### 3.2. Volume streaming pipeline
```
metadata.json  ──┐
manifest.json  ──┼─→ BrickLoader (LRU 200 bricks)
.pack files (gzipped 64³ blocks)
                 │       │
                 │       ├─→ brick-fetch-worker (range fetch)
                 │       └─→ brick-decode-worker (gunzip + unmosaic)
                 │
                 ↓
            SVRManager (3D atlas pages)
                 │
                 ↓
       VolumeViewer (Three.js ray-march shader)
```
* Brick size : **64³** (see `BRICK_SIZE = 128` in [brick-loader.js](js/core/brick-loader.js:9) — note the legacy constant; bricks generated by `3-chunk_packer.py` use 64 with 8×8 mosaic = 512²).
* Atlas configs : cascading from 4096 → 256 slots, [svr-manager.js:7](js/core/svr-manager.js:7) — first config that allocates becomes active.
* LRU : 200 bricks in CPU RAM; pack cache 128.

### 3.3. Quality modes
The viewer keeps multiple LOD pyramids per dataset. `_qualityMode` in [viewer.js](js/pages/viewer.js) takes values like `'512x512'` `'1024x1024'` `'native'`. `VolumeViewer.onQualityProgress` reports load progress per LOD.

### 3.4. Multi-panel (Compare page)
`compare.html` mounts N iframes of `viewer.html?hideHeader=true&panelIndex=i`. Cross-panel sync via `window.postMessage` :
* `SYNC_CAMERA` — broadcast when not in z-stack mode.
* `SYNC_SLICER_SPEC` — full plane spec (axis, value, yaw/pitch/roll, slab, mode).
* `SIDEBAR_CLOSED`, `TOGGLE_ZSTACK`, etc.
See `viewer.js` `_bindMessage` and related guards (`_suppressSlicerSync`, `_zstackActive`).

---

## 4. Preprocessing pipeline — `preprocess/`

Run end-to-end with [run_preprocess.py](preprocess/run_preprocess.py) — it orchestrates four numbered scripts on `.ims` (Imaris HDF5) inputs and writes to `DATA_WEB/fixed/<dataset_name>/`.

| Step | Script | Output |
|---|---|---|
| 1 | [1-ims_metadata.py](preprocess/1-ims_metadata.py) | `meta.json` — dataset dimensions, voxel size, channels (parses HDF5 `DataSetInfo`) |
| 2 | [2-image_processor.py](preprocess/2-image_processor.py) | Per-channel `.bin` LOD pyramids — background subtraction (Otsu + morphological opening to kill hot pixels), window leveling, downscale, `uint16 → uint8`. **Heavy CPU step.** |
| — | (inline) `build_thumbnail` in `run_preprocess.py` | `thumbnail.webp` — false-color MIP composite |
| 3 | [3-chunk_packer.py](preprocess/3-chunk_packer.py) | `bricks/lodN/...` — splits to 64³ chunks, mosaics into 512² PNGs, gzip-packs into `.bin` packs + `manifest.json`. ESS (Empty Space Skipping) : drops bricks with occupancy < 0.0005. |
| 4 | [4-catalog_generator.py](preprocess/4-catalog_generator.py) | `metadata.json` per dataset — pushed into root `DATA_WEB/catalog.json` |

**Stage parsing convention** — embryo names like `Egfl7eGFP-E8-5-…` encode stage `E8.5` (regex in `4-catalog_generator.py:_parse_stage`) and embryo id `Em<n>`.

---

## 5. Data layout — `DATA_WEB/`

```
DATA_WEB/
├── catalog.json                # Aggregated dataset index (consumed by Catalog.load())
├── fixed/<dataset>/            # Static volumes
│   ├── metadata.json           # Per-dataset config: dims, voxels, channels, volumeSources
│   ├── thumbnail.webp
│   └── bricks/
│       ├── manifest.json       # Brick index (lod, coords → pack offset/length)
│       ├── lod0/  lod1/  lod2/ lod3/   # .bin pack files (gzipped 64³ mosaics)
├── live/<dataset>/             # 4D timelapse volumes (same shape + per-timepoint folders)
└── tracking/<dataset>/         # Cell tracking trajectories
```

**Dataset types** drive UI (filters, viewer behavior) : `fixed`, `live`, `tracking`. Set by the directory `<type>/` under `DATA_WEB`.

---

## 6. Servers & launch

| Command | Purpose |
|---|---|
| `python dev_server.py` (port 8080) | **Recommended dev server** — handles `/api/auth.php` + `/api/datasets.php` natively in Python, serves static files. Admin panel works. |
| `python fast_server.py` (port 8080) | Multi-threaded no-cache static server. **No admin API.** Useful for perf tests. |
| `start.bat` | Windows launcher — opens browser + `python -m http.server 8000`. **No admin API.** |
| PHP (`api/*.php`) | Legacy — only if hosting on PHP. `dev_server.py` re-implements the same routes. |

**Admin credentials** : `api/config.json` (SHA-256 hashed password). Default user `admin`. Change via `python dev_server.py --set-password`.

---

## 7. Where do I find X? — quick reference

| Need to change… | Look in… |
|---|---|
| Ray-march shader / volume material | [js/viewers/volume-viewer.js](js/viewers/volume-viewer.js) + shader plugins in `js/modules/shaders/<id>/index.js` |
| Brick loading strategy / LRU policy | [js/core/brick-loader.js](js/core/brick-loader.js) |
| GPU atlas sizing (VRAM resilience) | [js/core/svr-manager.js](js/core/svr-manager.js) `atlasConfigs()` |
| Slice plane (oblique / orthogonal) | [js/viewers/volume-viewer.js](js/viewers/volume-viewer.js) `_planeSpec`, [js/viewers/volume-slicer.js](js/viewers/volume-slicer.js) |
| 3D measurement (distance picking) | [js/modules/tools/measure-distance/index.js](js/modules/tools/measure-distance/index.js) + [js/core/measurement-store.js](js/core/measurement-store.js) |
| Channel UI (gamma, color, min/max) | [js/components/channel-panel.js](js/components/channel-panel.js) + `js/modules/channels/*` |
| Histogram computation | [js/modules/channels/histogram/index.js](js/modules/channels/histogram/index.js) (uses `AnalysisStore`) |
| Per-channel gaussian blur | [js/modules/channels/gaussian-filter/index.js](js/modules/channels/gaussian-filter/index.js) + [js/workers/gaussian-blur-worker.js](js/workers/gaussian-blur-worker.js) |
| Workspace save / restore | [js/core/workspace-state.js](js/core/workspace-state.js) + `tools/save-workspace`, `tools/restore-workspace` |
| Multi-panel compare sync | `compare.js` (parent) + `viewer.js` `postMessage` handlers |
| Dataset CRUD (admin) | [js/pages/admpan.js](js/pages/admpan.js) + `api/datasets.php` (or Python equivalent in `dev_server.py`) |
| Translations | `lang/{en,fr,es}.json` |
| Add a new tool | Create `js/modules/tools/<id>/{plugin.json, index.js}` — auto-discovered, no manifest to edit. `plugin.json` drives the button (`group`, `subtype`, `icon`, `order`, `i18nTitle`, optional `tool`/`shortcut`/`requires`). Toolbar generation: [plugin-registry.js](js/core/plugin-registry.js) `buildToolbarButtons` |
| Adjust preprocessing background subtraction | [preprocess/2-image_processor.py](preprocess/2-image_processor.py) — Otsu + morphological opening |
| Change brick size / ESS threshold | [preprocess/3-chunk_packer.py](preprocess/3-chunk_packer.py) — `BRICK_SIZE`, `occ > 0.0005` |
| Stage / embryo regex | [preprocess/4-catalog_generator.py](preprocess/4-catalog_generator.py) `_parse_stage`, `_parse_embryo` |
| Perf telemetry instrumentation | `PerfTelemetry.start/end/event/setContext` calls scattered in `viewer.js` + [js/core/perf-telemetry.js](js/core/perf-telemetry.js). Note: the old `DOCS/perf_baseline_*.json` snapshots were removed from the repo — regenerate locally if needed. |
| Embryo orientation calibration | [js/modules/tools/orientation-axes/index.js](js/modules/tools/orientation-axes/index.js) (drag gizmo + postMessage to admin) |

---

## 8. Conventions

* **No ESM, no bundler** — JS is `<script>`-tag concatenation order from the HTML. Module pattern is IIFE returning a singleton (`const Foo = (() => { … return { … }; })();`).
* **Globals live on `window`** by virtue of top-level `const` in classic script context (each file is its own `<script>` element).
* **No build step** — edits in `js/` are reflected on page reload. Dev server forces `no-cache` headers.
* **CDN deps** are pinned (Three.js `0.167.0`, Lucide `0.344.0`) — see `index.html` `<head>`.
* **Comments** : keep them only when the WHY is non-obvious (a constraint, a workaround, a scientific formula). Don't narrate WHAT the code does — well-named identifiers cover that. Don't reference past tasks / issue numbers in code.
* **Logs** dropped to `logs/` at server runtime (`dev_server.py` writes `dev-server-<timestamp>.{log,err.log}`).

---

## 9. Definitely don't…

* …re-introduce `// TODO` or mock data paths in the streaming pipeline (rule 1.1).
* …allocate a `THREE.Texture` per brick — use `SVRManager` atlas slots.
* …do CPU-heavy work on the main thread — push to a worker (see existing workers as templates).
* …commit datasets in `DATA_WEB/fixed|live|tracking/` (large binary, gitignored — only `catalog.json` and `.gitkeep` are tracked).
* …skip the versioning + changelog routine after a substantive edit (rule 1.5).
* …reorder `PluginRegistry.loadModules` to after UI build — channel/shader/tool lists will be empty (lesson from v0.12.45).
