# CLAUDE.md — Lumen3D / IRIBHM Microscopy Platform

> **Light-based Unified Microscopy Exploration in 3D** — High-performance browser-based viewer for multi-gigabyte confocal microscopy volumes (mouse embryos, IRIBHM lab @ ULB). 60 FPS streaming, scientific tooling, Python preprocessing pipeline.

**Stack** : Vanilla JS (no framework, IIFE modules), Three.js (UMD, **self-hosted** under `js/vendor/` since v1.6.0 — not CDN), custom WebGL2 ray-marcher, Python preprocessing (h5py / numpy / scipy / PIL), dev server in Python (`dev_server.py`) — PHP fallback in `api/` for legacy hosts.

**Current versions** : Plateforme Web `1.12.3` (latest changelog `changelog/changelog_1.12.3.md`; v1.5.0 is the first published GitHub release), Preprocessing `0.14.1` (`preprocess/run_preprocess.py:__version__`). ⚠️ Note: `dev_server.py:__version__` is `0.15.0` and **drifts from the web platform version** — it tracks the server tool itself, not the platform. The Web platform version lives **only** in the `changelog/` filenames; bump by adding a new `changelog_X.Y.Z.md`. Older 0.x → 1.2.x changelogs are archived under `changelog/archive/` (excluded from version computation — it globs the flat level only).

> **Since v1.5.0/v1.6.0 the platform gained three major subsystems** (details in §2/§7, `DOCS/update-system/`, `DOCS/plugin-sandbox/`): **(1) robust self-updater** — Blue-Green staging swap + health-gated restart + auto-rollback in `dev_server.py`; a **release CI** (`.github/workflows/`, `tools/build_release.py` → curated `lumen3d-web-X.Y.Z.zip` + `version.json` + `SHA256SUMS`); a one-file `install.php`. **(2) plugin↔platform compatibility** — `platformCompat` (list/range) in `plugin.json`, resolver twins `js/core/compat.js` + `dev_server.py:_compat_satisfies` + `api/_admin_lib.php`. **(3) third-party plugin isolation** — default-deny **trust gate** (`js/core/plugin-trust.js`; operator approval pinned to a content hash) + **iframe sandbox** (`js/core/plugin-sandbox.js`) + **enforced strict CSP** (per-request nonce injected by `dev_server.py:_serve_html`; libs self-hosted in `js/vendor/`; inline handlers → `js/core/ui-actions.js` `data-action` delegation).
>
> **v1.7.0 hardening** (closes the v1.6.0 deferred list): **(a) release authenticity** — vendored pure-Python Ed25519 verifier (`ed25519_pure.py`, RFC 8032, stdlib-only) + a **pinned publisher key** (`dev_server.py:_RELEASE_PUBKEY_HEX`, `install.php:$PINNED_PUBKEY`, both empty until keyed); CI signs `SHA256SUMS`→`SHA256SUMS.sig` from the `LUMEN_SIGNING_KEY` secret; updater verifies fail-closed before applying, installer via PHP libsodium (`tools/gen_signing_key.py` bootstraps the pair). **(b) CSP on PHP/static hosts** — `api/_html_server.php` + `_serve.php` + root `.htaccess` + `router.php` + `fast_server.py` all inject the per-request nonce + enforcing CSP (no longer Python-only). **(c) `style-src` element lockdown** — `style-src-elem 'self' 'nonce-…'` (no `unsafe-inline`; injected `<style>` blocked), `style-src-attr` keeps inline for data-driven `style=""`. **(d) nonce hardening** — the world-readable `<meta name="csp-nonce">` is gone; consumers read `document.currentScript.nonce` (nonce-hiding protected) and their `<script>` tags carry the nonce. **(e) sandbox completion** — `trustEpoch` hot-revocation, host→frame `events.subscribe` emission, workspace-state bridge, event-driven toggle. Shaders are in-page-trust-only by design; sandboxed channels deferred (see `DOCS/plugin-sandbox/SPEC.md` §Placement).
>
> **v1.8.0 → v1.12.1 — white-label generalization** (spec in `DOCS/whitelabel/PLAN.md`): the platform is decoupled from the IRIBHM/embryo domain into a reusable product. **(1) Instance-config layer** — a PUBLIC `config/` store (`instance.json`, `theme.json`→compiled `theme.css`, `pages/<slug>.json`, `legal.json`; neutral defaults under `config/defaults/neutral/`) read by `js/core/instance-config.js` (IIFE `InstanceConfig`). Head/brand injected server-side via `{{SITE:path|fallback}}` (`dev_server.py:_serve_html` + `api/_html_server.php:lumen_apply_site`); client binds `[data-instance]`; `I18n.t()` interpolates `{brand}`/`{specimen}`… tokens (specimen noun is per-locale). Persisted via `/api/site.php` (Python + `api/site.php` PHP twins; `config/*` in `_UPDATE_PROTECT`). **(2) No-code admin editors** — new ESM tabs: **Identity** (`tab-branding`), **Pages** (`tab-pages`, Elementor-style block builder → `js/core/page-renderer.js` + `page.html?slug=`), **Appearance** (`tab-appearance` theme editor), **Legal** (`tab-legal` → `legal.html`), **Catalog** (`tab-marketplace`). **(3) Guided setup wizard** — `shell.js` 5-step first-run (account → identity → theme → texts → plugin picker). **(4) Signed plugin marketplace (app-store model)** — plugins are NOT bundled in a release (`build_release.py` excludes `js/modules/{tools,channels,shaders}/*`); they install on demand from a curated Ed25519-**signed catalog** (`marketplace/`, pinned key `_MARKETPLACE_PUBKEY_HEX`/`MARKETPLACE_PUBKEY`, separate from the core release key). Publish with **`tools/publish_plugin.py <dir> --push`** (one command → live). See `marketplace/README.md`.

---

## 1. Operating rules (read first, every time)

### 1.1. Code standard — production-grade, scientific rigor
* **Zero approximation** : no `// TODO`, no placeholder, no mock in the data pipeline. The streaming/parsing path must be final and robust.
* **Algorithmic transparency** : every coordinate transform (matrices), every biological calculation, every shader formula must be explicit and mathematically documented in-code. No "magic" hidden behind helpers when the science matters.
* **Render fallbacks** : if VRAM is exhausted or a brick is corrupted, the viewer must degrade gracefully (lower LOD, drop the brick, surface a status). Never crash the tab. Reference impl : [SVRManager.atlasConfigs](js/core/svr-manager.js) — cascading atlas sizes; [BrickLoader fallback path](js/core/brick-loader.js) — `_supportsWebGL3D` + 2D fallback canvas.

### 1.2. Performance constraints (the file size mandates this)
* **Streaming over loading** : volumes are sliced into 64³ bricks, packed in `.bin` packs with a `manifest.json` per dataset. Never load a full volume in one buffer. See [brick-loader.js](js/core/brick-loader.js), [brick-decode-worker.js](js/core/brick-decode-worker.js).
* **GPU memory hygiene** : every `THREE.Texture`/`Geometry`/`Material` must be `.dispose()`'d on dataset switch or tool teardown. The `SVRManager` reuses 3D atlas pages — do not allocate new textures per brick.
* **Main thread inviolable** : heavy work (decode, gaussian blur, parsing) lives in Web Workers (`js/workers/`, `js/core/brick-*-worker.js`). UI thread reserved for Three.js + DOM.

### 1.3. UX rules
* Toolbar should stay sparse — 3D canvas owns the screen. Tools surface in the sidebar or as plugin buttons; group via `plugin.json#group`.
* Long ops (preprocessing, brick loading, quality upgrades) must surface precise progress (% + step name), not a spinner. See `_handleQualityProgress` in [viewer.js](js/pages/viewer.js).

### 1.4. Security (no auth, but defensive)
* Validate dataset structure on load (dimensions, channel count, manifest integrity). A malformed `metadata.json` must be rejected, not partially mounted.
* Never POST study data to third parties. The platform is offline-capable; JS libraries (Three.js, Lucide, OpenSeadragon, Plotly) are **self-hosted** under `js/vendor/`. The only remote dependency is Google Fonts (CSS/fonts), allowed by `style-src`/`font-src` in the CSP.

### 1.5. Autonomous versioning — APPLY ON EVERY CHANGE, NO REMINDER NEEDED
The user expects this to happen silently as part of every edit:

* **SemVer** : `0.Y.Z` until the explicit `1.0.0` order was given (already received — web is now in `1.x`). Bump `Z` on every fix / shader tweak / script change. Bump `Y` every 3–5 minor versions or when integrating a major tool / new rendering engine / new compression algorithm.
* **Component scope** : two independent versioned components.
  * `Plateforme Web` → bump only by creating a new `changelog/changelog_X.Y.Z.md`. There is no single source-of-truth `__version__` constant for the Web platform (the `dev_server.py:__version__` is the dev server's own version, not the platform's — has drifted).
  * `Outil de Preprocessing` → version string in `preprocess/run_preprocess.py:__version__` (and the four step scripts `preprocess/1-…py` → `4-…py` carry their own `__version__` where relevant). Changelogs in `preprocess/changelog/changelog_X.Y.Z.md`.
* **Changelog format** : sections `[ADDED]` (features/tools), `[OPTIMIZED]` (perf, shaders, parsing), `[FIXED]` (bugs). Markdown headings — see `changelog/changelog_0.12.45.md` for the canonical shape.
* **End-of-response notice** : after a versioning bump, append a discreet line, e.g.
  `[Versioning] Plateforme Web → v1.0.2. changelog_1.0.2.md généré.`

### 1.6. Git workflow — develop on `dev`, keep `main` stable (user preference, updated 2026-06-24)
The repo keeps **exactly two branches** : **`main`** (stable) and **`dev`** (active development). The user wants **all development on `dev`**, with **no sub-branches** (`feat/…`, `fix/…`, `claude/…`) and no git worktrees.
* **No worktrees / no sub-branches** : never create git worktrees, never spawn agents with `isolation: "worktree"`, and don't spin up `feat/…`/`fix/…` branches for routine work. Always work in the primary checkout of this repo, on the `dev` branch — the checkout path varies by machine (e.g. `D:\Coding\WebPlatform` on host MSI), so don't assume a hardcoded location.
* **Commit straight to `dev`** : default to committing/pushing on `dev` (not protected — direct pushes succeed). Commit finished, verified work promptly — untracked files have been wiped before by branch updates.
* **Integrate `dev → main` only when the user explicitly asks.** Likewise, only create a branch / open a PR when the user *explicitly* asks (e.g. invokes the create-PR command). That request overrides this default for that task only.

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
| Admin | `admpan.html` | [admpan.js](js/pages/admpan.js) | Multi-tab admin SPA — datasets CRUD, stats, plugins, marketplace/**Catalog**, security/password, GitHub updates, **Identity/Pages/Appearance/Legal** (white-label editors). Auth via `api/`. See note below. |
| About | `about.html` | [about.js](js/pages/about.js) | Lab info |
| Widgets | `widgets.html` | — | Standalone widget demo |

> **Admin panel is the one ESM exception** (since web v1.4.0 / commit `38660ca`) : `admpan.html` loads `admpan.js` via `<script type="module">`, and `admpan.js` + the tab modules under `js/pages/admin/{shell,bus,shared,tab-datasets,tab-stats,tab-plugins,tab-security,tab-updates,tab-branding,tab-pages,tab-appearance,tab-legal,tab-marketplace}.js` use real `import`/`export`. This is a deliberate carve-out from the "no ESM" rule in §8 — the rest of the platform stays classic-script/IIFE.
>
> **DeepZoom removed** : the former `deepzoom.html` page, `js/components/deepzoom-viewer.js`, and `js/modules/tools/deepzoom-2d` plugin were deleted (see `changelog/changelog_1.2.1.md`). There is currently no 2D DZI pyramid viewer in the platform.

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
| [i18n.js](js/core/i18n.js) | Loads `lang/{en,fr,es}.json`, exposes `I18n.t(key)`. Languages are **discovered dynamically** (`GET /api/languages` → `lang/manifest.json` → embedded default); plugin dictionaries (`js/modules/.../lang/<code>.json`) merge under `plugins.<id>` so per-plugin English fallback is automatic. `I18n.forPlugin(id)`→`ctx.i18n`; `getAvailableLanguages()` + `Utils.populateLanguageMenu()` drive the switcher. See [changelog_1.2.0.md](changelog/changelog_1.2.0.md). |
| [utils.js](js/core/utils.js) | Date / stage formatting, math helpers |
| [url-state.js](js/core/url-state.js) | Serializes viewer state into URL params |
| [workspace-state.js](js/core/workspace-state.js) | Save/restore camera + channels + tool state |
| [plugin-registry.js](js/core/plugin-registry.js) | **Module loader** — fetches `plugin.json` + injects `index.js`, dispatches hooks. See §3.1. |
| [tool-manager.js](js/core/tool-manager.js) | Active tool mux (navigate / measure / slice / …) |
| [svr-manager.js](js/core/svr-manager.js) | **Sparse Volume Renderer** — manages 3D texture atlas pages on the GPU, cascading sizes for VRAM resilience |
| [brick-loader.js](js/core/brick-loader.js) | LRU brick cache, fetches whole `.bin` packs (main thread), dispatches WebP tiles to the decode-worker pool |
| [brick-decode-worker.js](js/core/brick-decode-worker.js) | Worker — WebP decode (createImageBitmap) + un-mosaic 64³ bricks |
| [volume-source-manager.js](js/core/volume-source-manager.js) | Normalizes per-dataset `volumeSources` (webstack / bricks / live) |
| [annotation-manager.js](js/core/annotation-manager.js) | 3D annotation primitives + persistence |
| [annotation-layer.js → js/components](js/components/annotation-layer.js) | Component layer that renders annotations |
| [measurement-store.js](js/core/measurement-store.js) | Persisted distance measurements per dataset (LocalStorage) |
| [analysis-store.js](js/core/analysis-store.js) | Per-channel analysis results (histograms, decomposition) |
| [aabb-intersector.js](js/core/aabb-intersector.js) | Ray ↔ AABB math for slice plane picking |
| [display-presets.js](js/core/display-presets.js) | Background presets (dark, ortho, paper) |
| [colorblind.js](js/core/colorblind.js) | CB-safe channel palettes |
| [download-manifest.js](js/core/download-manifest.js) | Builds export bundles |
| [export-manager.js](js/core/export-manager.js) | Backs the Download Center — workspace save/restore, measures/metadata/annotations export, downloadable-bundle browser, citation block |
| [perf-telemetry.js](js/core/perf-telemetry.js) | `PerfTelemetry.start/end/event/setContext` — instrumentation calls scattered in `viewer.js`. The historical `DOCS/perf_baseline_*.json` snapshots have been removed from the repo. |
| [compat.js](js/core/compat.js) | `Compat.satisfies(platformVer, decl)` — plugin↔platform compat resolver (list/range, `^`/`~`/`.x`). Twin of `dev_server.py:_compat_satisfies` + PHP; validated by `tests/compat-vector.json`. Fail-closed. |
| [plugin-trust.js](js/core/plugin-trust.js) | `PluginTrust.evaluate` — client trust twin: canonical content hash (`crypto.subtle` over raw bytes) re-verified against the server vouch, anti-TOCTOU. Tiers bundled/dev/approved/untrusted. |
| [plugin-sandbox.js](js/core/plugin-sandbox.js) | `PluginSandbox` — HOST side of the iframe-sandbox RPC broker (null-origin `srcdoc`, capability-scoped `postMessage`, rate-limit/gesture-gate/heartbeat). Runs approved-sandboxed plugins. |
| [ui-actions.js](js/core/ui-actions.js) | `data-action` event delegation for header controls (theme/lang/colorblind) — replaces inline `onclick=` handlers so the strict CSP has no `unsafe-inline`. |
| [instance-config.js](js/core/instance-config.js) | **White-label** `InstanceConfig` — loads `config/instance.json`, exposes `get`/`tokens`/`applyDom`/`applyHead`/`applyNav`. i18n token source (`{brand}`/`{specimen}`…, specimen per-locale); `[data-instance]` DOM binding (client twin of the server `{{SITE:…}}` injection). Load it BEFORE `I18n.init()`. |
| [page-renderer.js](js/core/page-renderer.js) | **White-label** `PageRenderer` — renders `config/pages/<slug>.json` block layouts (11 block types, localized text, sanitized `html` block). Used by `page.html` (custom pages) + landing/about overrides. Authored via the admin Pages tab. |

### 2.4. JS viewers — Three.js renderers under `js/viewers/`

| File | Renders |
|---|---|
| [volume-viewer.js](js/viewers/volume-viewer.js) | **Main 3D ray-marcher** — owns scene/camera/renderer, cube material, slice plane, gizmos, measurement sprites |
| [volume-slicer.js](js/viewers/volume-slicer.js) | 2D oblique slice extraction from the volume |
| [volume-grid.js](js/viewers/volume-grid.js) | Spatial reference grid (xy/xz/yz planes), coordinate-axes gizmo, and scale-bar overlay — split out of `volume-viewer.js` for modularity |
| [tracking-viewer.js](js/viewers/tracking-viewer.js) | Cell tracking timelapse render |

### 2.5. JS components (UI panels) under `js/components/`

| File | Role |
|---|---|
| [channel-panel.js](js/components/channel-panel.js) | Per-channel sidebar (color, gamma, min/max, hosts channel-placement plugins) |
| [chart-studio.js](js/components/chart-studio.js) | Inline chart editor for histograms / analysis |
| [decomposition-panel.js](js/components/decomposition-panel.js) | Channel decomposition UI (decompose-channels tool) |
| [studio-editor.js](js/components/studio-editor.js) | "Production Slice Studio" — in-viewer figure/annotation export tool (rectangle/line/arrow/distance/scale-bar/text layers) for publication-ready slice captures; opened from `viewer.js` / `compare.js` — **not** part of the admin panel despite the name |
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
| `tools/download-center` | Export bundles (PNG, slice stacks, metadata) + workspace save/restore ("Save state" / "Restore state" buttons, via [export-manager.js](js/core/export-manager.js)) |
| `tools/decompose-channels` | Per-channel decomposition panel |
| `tools/zstack-browser` | Z-stack slice browser overlay |
| `tools/slice-inspector` | Oblique slice viewport |
| `tools/measure-distance` | 3D point-pick → calibrated µm distance |
| `tools/chunk-debug` | Debug overlay — draws brick/chunk boundaries, inspect chunk id/size/pack file on hover, Ctrl+wheel to cycle overlaps, click to copy metadata (3D / z-stack / oblique-slice) |
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
.bin packs (WebP 8×8 mosaics of 64³ bricks, fetched whole — no HTTP range)
                 │       │
                 │       └─→ brick-decode-worker pool (WebP decode via
                 │            createImageBitmap + un-mosaic 64³ bricks)
                 │
                 ↓
            SVRManager (3D atlas pages)
                 │
                 ↓
       VolumeViewer (Three.js ray-march shader)
```
* Brick size : **64³** (`BRICK_SIZE = 64` in [brick-loader.js](js/core/brick-loader.js:14); bricks generated by `3-chunk_packer.py` use 64 with 8×8 mosaic = 512² WebP tiles).
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
| 2 | [2-image_processor.py](preprocess/2-image_processor.py) | Per-channel `.bin` LOD pyramids — corner-sampling percentile background subtraction (`bg_floor` = 99th percentile of the 8 volume corners, `sig_max` = 99.9th percentile of a subsampled volume; `binary_opening` + `binary_dilation` mask cleanup kills hot pixels while preserving signal fade-out — Otsu was tried and deliberately removed in v0.12.0, see `preprocess/changelog/changelog_0.12.0.md`), masked median filtering, window leveling, downscale, `uint16 → uint8`. **Heavy CPU step.** |
| — | (inline) `build_thumbnail` in `run_preprocess.py` | `thumbnail.webp` — false-color MIP composite |
| 3 | [3-chunk_packer.py](preprocess/3-chunk_packer.py) | `bricks/lodN/...` — splits to 64³ chunks, mosaics into 512² WebP tiles (8×8, `brickPacking.mode = "grid"`), packs into `.bin` packs + `manifest.json`. ESS (Empty Space Skipping) : drops bricks with occupancy < 0.0005. |
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
│   ├── bricks/
│   │   ├── manifest.json       # Brick index (lod, coords → pack offset/length)
│   │   └── lod0/  lod1/  lod2/ lod3/   # .bin pack files (WebP 8×8 mosaics of 64³ bricks)
│   └── download/               # optional (--with-downloads): original .ims (hardlink), calibrated OME-TIFF, per-channel MIP PNGs, _web.zip, README.txt
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

**Admin credentials** (since web v1.4.0) : `api/admin_credential.json` — a one-way salted **PBKDF2-HMAC-SHA256** hash (no plaintext), never served over HTTP (`api/` is blocked + `api/.htaccess`). No default password: a **missing** credential drives a first-run **setup** screen in the admin panel (`POST /api/auth.php?action=setup`, create-exclusive so it can't overwrite a live credential). Change it in-panel (Sécurité tab, needs the current password) or via `python dev_server.py --set-password` (operator override). The old `api/config.json` password store is no longer read (gitignored).

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
| Histogram computation | [js/modules/channels/histogram/index.js](js/modules/channels/histogram/index.js) (data supplied via a `getHistograms` callback from [js/components/channel-panel.js](js/components/channel-panel.js); `AnalysisStore` is used by `chart-studio.js` / `tracking.js`, not this plugin) |
| Per-channel gaussian blur | [js/modules/channels/gaussian-filter/index.js](js/modules/channels/gaussian-filter/index.js) + [js/workers/gaussian-blur-worker.js](js/workers/gaussian-blur-worker.js) |
| Workspace save / restore | [js/core/workspace-state.js](js/core/workspace-state.js) + [js/core/export-manager.js](js/core/export-manager.js) (wired into `tools/download-center`; also direct buttons on Tracking/Compare pages) |
| Multi-panel compare sync | `compare.js` (parent) + `viewer.js` `postMessage` handlers |
| Dataset CRUD (admin) | [js/pages/admin/tab-datasets.js](js/pages/admin/tab-datasets.js) (registered by [admpan.js](js/pages/admpan.js)) + `api/datasets.php` (or Python equivalent in `dev_server.py`) |
| Translations (platform) | `lang/{en,fr,es}.json` — full key parity required. Add a language by dropping `lang/<code>.json` (auto-discovered); display name/flag/RTL come from `LANG_META` in [i18n.js](js/core/i18n.js). |
| Translations (a plugin's own strings) | `js/modules/<placement>/<id>/lang/<code>.json` — call `ctx.i18n.t('key')` in `index.js`. List shipped locales in `plugin.json#i18nLanguages`. `en.json` is the mandatory fallback. |
| Add a new tool | Create `js/modules/tools/<id>/{plugin.json, index.js, lang/}` — auto-discovered, no manifest to edit. `plugin.json` drives the button (`group`, `subtype`, `icon`, `order`, `i18nTitle`→a key in the plugin's `lang/`, optional `tool`/`shortcut`/`requires`/`i18nLanguages`). Toolbar generation: [plugin-registry.js](js/core/plugin-registry.js) `buildToolbarButtons` |
| White-label instance config (brand/specimen/SEO/footer/nav) | `config/instance.json` (public store) ← [js/core/instance-config.js](js/core/instance-config.js); server head injection `{{SITE:…}}` in [dev_server.py](dev_server.py) `_serve_html`/`_apply_site_placeholders` + [api/_html_server.php](api/_html_server.php) `lumen_apply_site`; persisted via `/api/site.php` ([dev_server.py](dev_server.py) `_save_site_doc` + [api/site.php](api/site.php)). Admin UI: [tab-branding.js](js/pages/admin/tab-branding.js). |
| Theme editor (palette/font/radius) | [tab-appearance.js](js/pages/admin/tab-appearance.js) → `config/theme.json` → server-compiled `config/theme.css` ([dev_server.py](dev_server.py) `_generate_theme_css` + `api/site.php` twin); linked after `themes.css` on every public page. |
| Page builder (blocks) / custom pages / legal | [tab-pages.js](js/pages/admin/tab-pages.js) + [js/core/page-renderer.js](js/core/page-renderer.js) + [page.html](page.html) (`?slug=`); home/about overrides in `landing.js`/`about.js`. Legal: [tab-legal.js](js/pages/admin/tab-legal.js) + [legal.html](legal.html). Nav: `InstanceConfig.applyNav`. |
| Guided first-run setup wizard | [js/pages/admin/shell.js](js/pages/admin/shell.js) (5 steps incl. the plugin picker) + the `#setup-screen` markup in [admpan.html](admpan.html). Shows when `api/admin_credential.json` is absent. |
| Plugin marketplace (browse / install / uninstall) | [tab-marketplace.js](js/pages/admin/tab-marketplace.js) + [dev_server.py](dev_server.py) `_marketplace_list`/`_install_marketplace_plugin`/`_uninstall_marketplace_plugin` (+ `api/_admin_lib.php` `mkt_*` twins). Signed catalog under `marketplace/`; pinned key `_MARKETPLACE_PUBKEY_HEX`/`MARKETPLACE_PUBKEY` (separate from core release key). |
| **Publish a plugin to the marketplace** | `python tools/publish_plugin.py <plugin-dir> --push` (one command → live). Package/sign: [tools/build_plugin_release.py](tools/build_plugin_release.py). Full guide: [marketplace/README.md](marketplace/README.md). Plugins are un-bundled from releases ([tools/build_release.py](tools/build_release.py) excludes `js/modules/{tools,channels,shaders}/*`). |
| Adjust preprocessing background subtraction | [preprocess/2-image_processor.py](preprocess/2-image_processor.py) — corner-sampling percentile (`bg_floor`/`sig_max`) + `binary_opening`/`binary_dilation` |
| Change brick size / ESS threshold | [preprocess/3-chunk_packer.py](preprocess/3-chunk_packer.py) — `BRICK_SIZE`, `occ > 0.0005` |
| Stage / embryo regex | [preprocess/4-catalog_generator.py](preprocess/4-catalog_generator.py) `_parse_stage`, `_parse_embryo` |
| Perf telemetry instrumentation | `PerfTelemetry.start/end/event/setContext` calls scattered in `viewer.js` + [js/core/perf-telemetry.js](js/core/perf-telemetry.js). Note: the old `DOCS/perf_baseline_*.json` snapshots were removed from the repo — regenerate locally if needed. |
| Embryo orientation calibration | [js/modules/tools/orientation-axes/index.js](js/modules/tools/orientation-axes/index.js) (drag gizmo + postMessage to admin) |
| Self-update pipeline (staging swap / rollback / health-gate) | [dev_server.py](dev_server.py) `_run_update` → `_pivot_main` (supervisor) / `_reconcile_pivot` (boot recovery) / `--check` (offline boot gate). Admin UI: [tab-updates.js](js/pages/admin/tab-updates.js). Design: `DOCS/update-system/`. |
| Release build / CI / version guard | [tools/build_release.py](tools/build_release.py) (allowlist → curated zip + `version.json` + `SHA256SUMS`, signs `SHA256SUMS.sig` if `LUMEN_SIGNING_KEY`/`--sign-seed-hex` set), [tools/check_version.py](tools/check_version.py) (tag==newest changelog), [.github/workflows/{release,ci}.yml](.github/workflows/release.yml). One-file installer: [install.php](install.php). **Operational runbook** (publish a release, update a plugin, apply): [DOCS/update-system/RELEASING.md](DOCS/update-system/RELEASING.md). |
| Release authenticity (Ed25519 signature) | [ed25519_pure.py](ed25519_pure.py) (vendored RFC 8032 verify+sign, stdlib-only). **Pinned key** twins `dev_server.py:_RELEASE_PUBKEY_HEX` + `install.php:$PINNED_PUBKEY` (both empty ⇒ sha256-only + warning; set ⇒ signature MANDATORY, fail-closed). **Set the key in repo SOURCE + commit** — `dev_server.py` is not in `_UPDATE_PROTECT`, so a key set only on a deployed host is overwritten by the next update (self-publish model: the committed key ships in every release and survives updates; the first keyed release is sha256-only by TOFU). Updater verify: `dev_server.py:_verify_release_signature`; installer: `install.php:release_signature_ok` (PHP libsodium). Bootstrap a keypair: [tools/gen_signing_key.py](tools/gen_signing_key.py). Vectors: `tests/test_ed25519.py`, `tests/test_release_signature.py`. |
| Plugin↔platform compatibility (`platformCompat`) | [js/core/compat.js](js/core/compat.js) + [dev_server.py](dev_server.py) `_compat_satisfies` + [api/_admin_lib.php](api/_admin_lib.php) `admin_compat_satisfies`. Vector: `tests/compat-vector.json`. Declare `platformCompat` (list/range) in `plugin.json`. |
| Plugin trust / operator approval (third-party isolation) | [js/core/plugin-trust.js](js/core/plugin-trust.js) + [dev_server.py](dev_server.py) `_classify_plugin`/`_approve_plugin` (store `api/plugin-trust.json`, protected). Admin approve/revoke UI: [tab-plugins.js](js/pages/admin/tab-plugins.js). Untrusted plugins are excluded from `/api/plugins`. |
| Plugin sandbox (run untrusted UI plugin in an iframe) | [js/core/plugin-sandbox.js](js/core/plugin-sandbox.js) (host RPC broker) + example [js/modules/tools/screenshot-sandboxed/](js/modules/tools/screenshot-sandboxed/). Capability adapter wired in [viewer.js](js/pages/viewer.js) `PluginSandbox.bindContext`. |
| Content-Security-Policy (enforced, nonce) | [dev_server.py](dev_server.py) `_csp_policy` + `_serve_html` (per-request nonce → `{{CSP_NONCE}}`); **twin** `api/_html_server.php:lumen_csp_policy`/`lumen_serve_html` now enforces on PHP hosts too (`_serve.php`+root `.htaccess`, `router.php`) and `fast_server.py` imports `_csp_policy`. `script-src 'self' 'nonce-…'`; `style-src-elem 'self' 'nonce-…'` (no `unsafe-inline` → injected `<style>` blocked), `style-src-attr 'unsafe-inline'` (data-driven `style=""`). Nonce read from `document.currentScript.nonce` (no world-readable `<meta>` since v1.7.0); nonce-consuming scripts (`plugin-registry`, `plugin-sandbox`, `colorblind`) carry `nonce=` on their tag. Inline handlers → `data-action` ([js/core/ui-actions.js](js/core/ui-actions.js)). Self-hosted libs: `js/vendor/`. |

---

## 8. Conventions

* **No ESM, no bundler** — JS is `<script>`-tag concatenation order from the HTML. Module pattern is IIFE returning a singleton (`const Foo = (() => { … return { … }; })();`). **Exception** : the admin panel (`admpan.html` + `js/pages/admpan.js` + `js/pages/admin/*.js`, since v1.4.0) is loaded via `<script type="module">` and uses real `import`/`export` — this is a deliberate, contained carve-out for that one page, not a platform-wide shift.
* **Cross-file globals** — each file is its own classic `<script>`, and a top-level `const Foo = (…)()` is a global **lexical** binding: reachable by the bare name `Foo` from any other script on the page, but **NOT** exposed as `window.Foo` (only `var`/explicit `window.x=` attach to `window`). So reference singletons by bare name (`Theme`, `Utils`, `I18n`), guarded with `typeof Foo !== 'undefined'` — never `window.Foo`, which is `undefined` for these (this misconception caused a real toggle-breaking bug in v1.6.0, see `js/core/ui-actions.js`).
* **No build step** — edits in `js/` are reflected on page reload. Dev server forces `no-cache` headers.
* **Vendored deps** are **self-hosted** under `js/vendor/` since v1.6.0 (Three.js `0.147.0`, Lucide `0.344.0`, OpenSeadragon `3.0.0`, Plotly `2.27.0`), loaded with SRI `integrity` from `'self'` so the strict CSP needs no CDN origin and the platform runs offline. `js/vendor/**` is marked `-text` in `.gitattributes` (byte-stable → SRI stays valid). Only Google Fonts is still remote (CSS/font-src, not script). Do **not** re-introduce a CDN `<script src>` — it would be blocked by the enforced `script-src 'self' 'nonce-…'`.
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
