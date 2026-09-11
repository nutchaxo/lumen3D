# CLAUDE.md — Lumen3D / IRIBHM Microscopy Platform

> **Light-based Unified Microscopy Exploration in 3D** — High-performance browser-based viewer for multi-gigabyte confocal microscopy volumes (mouse embryos, IRIBHM lab @ ULB). 60 FPS streaming, scientific tooling, Python preprocessing pipeline.

**Stack** : Vanilla JS (no framework, IIFE modules), Three.js (UMD, **self-hosted** under `js/vendor/` since v1.6.0 — not CDN), custom WebGL2 ray-marcher, Python preprocessing (h5py / numpy / scipy / PIL), dev server in Python (`dev_server.py`) — PHP fallback in `api/` for legacy hosts.

**Current versions** : Plateforme Web `1.53.1` (latest changelog `changelog/changelog_1.53.1.md`; v1.5.0 is the first published GitHub release), Preprocessing `0.18.0` (`preprocess/run_preprocess.py:__version__`). ⚠️ Note: `dev_server.py:__version__` is `0.15.0` and **drifts from the web platform version** — it tracks the server tool itself, not the platform. The Web platform version lives **only** in the `changelog/` filenames; bump by adding a new `changelog_X.Y.Z.md`. Older 0.x → 1.2.x changelogs are archived under `changelog/archive/` (excluded from version computation — it globs the flat level only).

> **v1.53.0 — cell tracking is a layer of a timelapse, not a dataset type.** The former fourth type `tracking` (and its page `tracking.html`, `js/pages/tracking.js`, `js/viewers/tracking-viewer.js`, plus the orphaned `AnalysisStore`/`ChartStudio`) is **gone**: the pipeline always wrote a tracked acquisition to `DATA_WEB/live/` with `tracks.json` + `model.glb` beside the bricks and a `tracking`/`registration` block in `metadata.json`, and the viewer draws it as the sidebar layer of that dataset (v1.31.0). The page's tools are now **five `live`-only plugins** gated by `requires: ["tracking"]` — `tracking-trails`, `tracking-surface`, `tracking-inspector` (tool `inspect`), `tracking-charts`, `tracking-measure` (tool `cell-measure`) — built on the **`ctx.tracking` façade** of `viewer.js` (packed tables from `js/workers/tracks-load-worker.js` via `TrackingOverlay`: `positionUm/positionObject/cellsAt/pick`, one shared selection and neighbour radius, events `loaded/frame/refresh/selection/options/style`, `whenLoaded()`), `ctx.ui.addSidebarSection/addCanvasPanel`, `ctx.tools.onChange`, and the `getExports()`/`getGraph()` hooks collected by `PluginRegistry.collect()`. A deployment is converted by the same one-shot migration as v1.51.0 (empty `DATA_WEB/tracking/` removed, a non-empty one left and logged, `pageTitles.tracking`/`nav.showTracking`/`datasetTypes.tracking` dropped, `?type=tracking` links re-pointed to `live`). Tests: `tests/js/test_tracking_plugins.mjs`, `tests/test_migrate_tracking_type.py`.
>
> **v1.51.0 — one canonical dataset-type vocabulary.** A dataset type is **`3d` | `2d` | `live`** (a fourth one, `tracking`, existed until v1.53.0), and that one spelling is simultaneously the directory under `DATA_WEB/` and `uploads/staging/`, the first segment of a dataset id, the `"type"` field of `metadata.json`, what `plugin.json#dataTypes` declares, the `<type>` of `staging:<type>/<folder>` and of the import journal `uploads/state/<type>__<folder>.json`, the `?type=` filter value, and the suffix of the `badge-<type>` / `type-card--<type>` CSS classes. `fixed` and `wholemount` are **gone from the code** — no alias, no dual read, no compatibility layer. `dataset.id` and `dataset.path` now both carry `'<type>/<folder>'` (kept as two fields because callers use both, but they hold the same string), and `metadata.json`'s own `"id"` uses the same form. What the operator *sees* is never a type id: names come from `config/instance.json` `datasetTypes.<type>.{label,title}` (admin tab **Types de données**), falling back to `types.<type>.{label,title,desc}` in `lang/<code>.json`. Client-side, `js/core/utils.js` is the single source (`Utils.DATASET_TYPES`, `datasetTypeLabel/Title/Icon/BadgeClass/Gradient`, `datasetPage`, `datasetUrl`) — never hardcode a label or a per-type table. An existing deployment is converted by a **one-shot, idempotent migration** run by both backends at startup (see §5).
>
> **v1.43.0 — browser dataset import.** An operator drags the folder the preprocessing pipeline produced into the admin **Import** tab and it streams up, resumable and hash-verified, with no SFTP. Engine: `upload_staging.py` + PHP twin `api/_upload_lib.php` (one shared journal format — an import started under one backend resumes under the other). Bytes land in a NEVER-SERVED `uploads/` staging root (`_FORBIDDEN_ROOTS` + root `.htaccess` + `router.php` + its own deny-all), pass a **closed path allowlist** (only what the pipeline emits; `.php`/`.js`/dotfiles/traversal refused before a byte is written), and only reach `DATA_WEB/` on an explicit *publish* once `validate_dataset` proves the manifest's `brickToPack` index resolves inside the packs that actually arrived. Files are uploaded in **priority tiers** (metadata+manifest+coarsest LOD first) so a dataset is openable and editable minutes into a multi-hour transfer; an edit then LOCKS `metadata.json` so the rest of the transfer cannot overwrite it. Transfer runs entirely in `js/workers/upload-worker.js` (raw 8 MiB octet bodies, never base64; parallelism is per-CHUNK). Admin preview of a staged dataset goes through the session-gated `api/upload.php?action=blob` proxy — see `js/pages/viewer.js:_datasetBase` and the `staging:<type>/<folder>` id form.
>
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
* **Changelog format** : sections `[ADDED]` (features/tools), `[OPTIMIZED]` (perf, shaders, parsing), `[FIXED]` (bugs). Markdown headings — see `changelog/archive/changelog_0.12.45.md` for the canonical shape.
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
| Compare | `compare.html` | [compare.js](js/pages/compare.js) | Side-by-side panels via iframes of `viewer.html` (volumes) or `2d.html` (photographs, linked by physical view `WM_PHYSICAL_VIEW`, since v1.50.0) |
| 2D | `2d.html` | [2d.js](js/pages/2d.js) (`App2D`) | **2D photograph viewer** (type `2d`, since v1.47.0; page/type renamed from `wholemount` in v1.51.0) — one calibrated stereomicroscope picture per dataset, pan/zoom canvas ([2d-viewer.js](js/viewers/2d-viewer.js), `Viewer2D`), scale bar, X-gal stain isolation, and a contact-sheet browser over every `2d` dataset of the catalog (filter by stage/line, ←/→, in-place switch, preview→native). Plugins load **opt-in** via `plugin.json#dataTypes`. Measurement labels are draggable (`labelOffset` in image px) with a size slider; *Open in Studio* hands the native canvas to `StudioEditor` (`sliceResult.dataset` + `pixelSizeUm{x,y}`); `?mode=admin&hideHeader=true&path=<type/folder or staging:…>` is the admin preview form (v1.48.0). Since v1.49.0 the viewer has three frames (image → oriented → canvas; rotation + mirror via `setOrientation`), display adjustments (`setAdjustments`, display-only), plugin overlays (`addOverlay`), a physical view (`get/setPhysicalView`: µm per CSS px + physical centre) and a pane mode (`?panelIndex=`) exchanging that view with its parent; the plugin ctx adds `ui.addSidebarSection`, `ui.getStage`, `ui.openStudioWith`, `dataset.getCollection/fileUrl/open/onChange`. `2d` plugins: `orientation-2d`, `calibrated-grid`, `display-adjust`, `split-view`, `figure-panel` (+ screenshot, presentation-mode, download-center, measure-distance). |
| Admin | `admpan.html` | [admpan.js](js/pages/admpan.js) | Multi-tab admin SPA — datasets CRUD, **dataset import (drag-drop, resumable)**, stats, plugins, marketplace/**Catalog**, security/password, GitHub updates, **Identity/Types de données/Pages/Appearance/Legal** (white-label editors). Auth via `api/`. See note below. |
| About | `about.html` | [about.js](js/pages/about.js) | Lab info |
| Widgets | `widgets.html` | — | Standalone widget demo |

> **Admin panel is the one ESM exception** (since web v1.4.0 / commit `38660ca`) : `admpan.html` loads `admpan.js` via `<script type="module">`, and `admpan.js` + the tab modules under `js/pages/admin/{shell,bus,shared,tab-datasets,tab-dataset-types,tab-stats,tab-plugins,tab-security,tab-updates,tab-branding,tab-pages,tab-appearance,tab-legal,tab-marketplace}.js` use real `import`/`export`. This is a deliberate carve-out from the "no ESM" rule in §8 — the rest of the platform stays classic-script/IIFE.
>
> **DeepZoom removed** : the former `deepzoom.html` page, `js/components/deepzoom-viewer.js`, and `js/modules/tools/deepzoom-2d` plugin were deleted (see `changelog/changelog_1.2.1.md`). There is currently no 2D DZI pyramid viewer in the platform.

### 2.2. CSS (`css/`)
Cascade order from [index.html](index.html:22) : `variables.css` → `themes.css` → `base.css` → `components.css` → `layout.css` → per-page (`landing.css` / `explorer.css` / `viewer.css` / `2d.css` / `admpan.css`) → `tools.css`.
* **Per-type classes** are always **prefixed** — `badge-<type>`, `type-card--<type>`. A bare `.3d` / `.2d` is not a valid CSS identifier (an identifier may not start with a digit), so the prefix is load-bearing, not cosmetic: never interpolate a raw type into a class name, use `Utils.datasetTypeBadgeClass()`.
* **Theme tokens** → [variables.css](css/variables.css), [themes.css](css/themes.css) (light/dark via `data-theme` attr).
* **Tool overlay styles** → [tools.css](css/tools.css).

### 2.3. JS core — singletons under `js/core/`
Loaded as classic `<script>` (no ESM), each exposes a global IIFE.

| Module | Role |
|---|---|
| [catalog.js](js/core/catalog.js) | Fetches `DATA_WEB/catalog.json`, exposes `Catalog.getById`, `list`, filters. **That URL is not a file** — it is generated per request by scanning `DATA_WEB/<type>/<name>/metadata.json` ([api/catalog.php](api/catalog.php) on PHP via an `.htaccess`/`router.php` rewrite, `dev_server.py:_build_catalog` on Python). The catalog holds no information of its own, so a dataset dropped in by SFTP appears immediately; there is nothing to regenerate. |
| [theme.js](js/core/theme.js) | Theme toggle + `data-theme` attribute, `Theme.onChange` listener |
| [i18n.js](js/core/i18n.js) | Loads `lang/{en,fr,es}.json`, exposes `I18n.t(key)`. Languages are **discovered dynamically** (`GET /api/languages` → `lang/manifest.json` → embedded default); plugin dictionaries (`js/modules/.../lang/<code>.json`) merge under `plugins.<id>` so per-plugin English fallback is automatic. `I18n.forPlugin(id)`→`ctx.i18n`; `getAvailableLanguages()` + `Utils.populateLanguageMenu()` drive the switcher. `I18n.raw(key)` resolves a key **without** token interpolation — `t()` interpolates `{type3d}`… through `InstanceConfig.tokens()`, which resolves right back through `Utils.datasetTypeLabel()`, so the type-name resolver must use `raw()` or recurse forever. See [changelog_1.2.0.md](changelog/changelog_1.2.0.md). |
| [utils.js](js/core/utils.js) | Date / stage formatting, math helpers, **and the single client-side source of the dataset-type vocabulary** : `DATASET_TYPES` (`['3d','2d','live']`), `VOLUME_DATASET_TYPES`, `isDatasetType`, `datasetTypeOfId`, `datasetTypeLabel/Title` (operator override → `types.<id>` translation → the id itself), `datasetTypeIcon`, `datasetTypeBadgeClass`, `datasetTypeGradient`, `datasetPage` (a dataset **or** a bare type), `datasetUrl`. Loaded on every page and re-exported by [shared.js](js/pages/admin/shared.js). |
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
| [instance-config.js](js/core/instance-config.js) | **White-label** `InstanceConfig` — loads `config/instance.json`, exposes `get`/`localized`/`tokens`/`applyDom`/`applyHead`/`applyNav`. i18n token source (`{brand}`/`{specimen}`…, specimen per-locale, plus `{type3d}`/`{type2d}`/`{typeLive}`); `[data-instance]` DOM binding (client twin of the server `{{SITE:…}}` injection). `localized(v)` unwraps a localizable value (a flat string **or** a `{en,fr,es,nl}` object) — `get()` returns it raw, so binding a per-locale value straight into the DOM prints `[object Object]`. `datasetTypes.<type>.{label,title}` holds the operator's own type names (empty ⇒ the `types.<type>` translation wins); `pageTitles` is keyed by `<body data-page>`, not by dataset type. Load it BEFORE `I18n.init()`. |
| [page-renderer.js](js/core/page-renderer.js) | **White-label** `PageRenderer` — renders `config/pages/<slug>.json` layouts. Since v1.13.0 the model is **sections → columns → widgets** (`renderSource`/`fetchSource`; responsive 12-unit columns via flex-wrap; 11 widget types = the former block types; localized text; sanitized `html`). **Backward-compatible** with the legacy flat `{blocks:[]}` shape (normalized to one 12-unit column — fixes old pages rendering blank). Used by `page.html` + landing/about overrides. Authored via the admin Pages tab (Elementor-style editor). |
| [page-templates.js](js/core/page-templates.js) | **White-label** `PageTemplates` (v1.25.0) — the built-in **default About page**, authored in the page-builder model (sections→columns→widgets). Single source for the live `about.html` (no static fallback markup any more) AND the admin Pages editor seed, so the two can't drift. Copy is embedded per-locale (`{en,fr,es}`) rather than keyed to `lang/*.json` — page text belongs to the document; white-label tokens (`{brandShort}`/`{org}`/`{year}`…) resolve at render time. |
| [page-edit-frame.js](js/core/page-edit-frame.js) | **White-label** `PageEditFrame` (v1.14.0) — the in-iframe runtime of the full-page visual editor. Loaded by `page.html` when `?edit=1`; `page-view.js` hands off to `PageEditFrame.init()`. Turns the REAL page into a WYSIWYG editing surface (per-widget PageRenderer output + editor chrome: hover outline, click-select, inline toolbar, pointer drag-reorder, drop zones). Emits *intents* (select/drop/action/resize) to the parent admin Pages tab over `postMessage`; the parent owns the model and re-pushes `LUMEN_EDIT_DOC` (one-way data-flow). CSP-safe (no injected `<style>`). |

### 2.4. JS viewers — Three.js renderers under `js/viewers/`

| File | Renders |
|---|---|
| [volume-viewer.js](js/viewers/volume-viewer.js) | **Main 3D ray-marcher** — owns scene/camera/renderer, cube material, slice plane, gizmos, measurement sprites |
| [volume-slicer.js](js/viewers/volume-slicer.js) | 2D oblique slice extraction from the volume |
| [volume-grid.js](js/viewers/volume-grid.js) | Spatial reference grid (xy/xz/yz planes), coordinate-axes gizmo, and scale-bar overlay — split out of `volume-viewer.js` for modularity |
| [tracking-overlay.js](js/viewers/tracking-overlay.js) | **Cell-tracking overlay of a `live` dataset** — instanced centroids sized in µm as a child of the volume cube, the ONE copy of the packed tracks (worker output: per-frame positions/slots + per-cell lineage CSR, flags, regions, `cellFrameSlot`), selection highlight, mitosis/fusion filters, `pick()` raycast, `positionUm/positionObject/cellsAt`. Exposed to plugins as `ctx.tracking` by `viewer.js`. |
| [2d-viewer.js](js/viewers/2d-viewer.js) (`Viewer2D`) | **2D photograph canvas** — view transform (`sx = ix·scale + tx`), two-step load (preview.webp painted first, image.webp swapped in when decoded), 1-2-5 scale bar from `pixelSizeUm`, distance picks with the same `{normalized, physicalUm}` contract as `VolumeViewer.onMeasurePoint`, stain isolation (B/R ratio gated by a box-blurred yellow-tissue context so background speckles stay dark; specimen dimmed grey, stain cyan). No Three.js. |

### 2.5. JS components (UI panels) under `js/components/`

| File | Role |
|---|---|
| [channel-panel.js](js/components/channel-panel.js) | Per-channel sidebar (color, gamma, min/max, hosts channel-placement plugins) |
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
| `tools/zstack-browser` | Z-stack browser (v1.1.1, web v1.52.5). Custom vertical slider: a **3D notch** above the track (default; every kept slice, rotation free), the track locks the view top-down and shows the cursor's slices; the cursor is a **bar of adjustable thickness** (drag an edge / *Thickness* stepper); two **triangular trim handles** mask the slices above / below in both modes. One `setClipRange_z` on the volume; the shader confines the march to the clip box + slab-normalises emission (see `volume-viewer.js` `hitClipBox`/`slabGain`) so a single slice renders. `SYNC_ZSTACK_SLICE` carries mode/cursor/thickness/crop; `ctx._state.zstackCurrentSlice` = cursor centre, −1 in 3D. **Studio**: `viewer.js:_zstackStudioSpec()` turns `getStudioSliceRange()` (bar, or kept range in 3D) into a slicer plane — one sample per slice (`slabStepNorm: 1/z`), MIP when thicker than one slice — rendered through a throwaway slicer material (inspector plane untouched), opened as preview then upgraded to native LOD0 over the whole slab depth. Tests: `tests/js/test_zstack_slab.mjs`, `test_zstack_echo.mjs`. |
| `tools/slice-inspector` | Oblique slice viewport |
| `tools/measure-distance` | 3D point-pick → calibrated µm distance |
| `tools/chunk-debug` | Debug overlay — draws brick/chunk boundaries, inspect chunk id/size/pack file on hover, Ctrl+wheel to cycle overlaps, click to copy metadata (3D / z-stack / oblique-slice) |
| `tools/tracking-trails` `tracking-surface` `tracking-inspector` `tracking-charts` `tracking-measure` | **Cell-tracking tools of a timelapse** (v1.53.0, `dataTypes: ["live"]`, `requires: ["tracking"]`): trajectories over the volume (length, path ahead, colour by region/speed); the exported surface `model.glb` inside the volume (uniform / cell-density / region colouring, follows the volume clip box, oblique cut plane with a filled cap); the *inspect* tool (metrics, lineage, neighbours, velocity field, exports); population/velocity/neighbour/mitosis charts (Plotly lazy-loaded from `js/vendor/`); the *cell-measure* tool (snapshot / follow-cells distances, `MeasurementStore` scope `tracking`). All read the packed tables through `ctx.tracking`, mount their UI through `ctx.ui.addSidebarSection/addCanvasPanel`, and hand exports to the Download Center through `getExports()`/`getGraph()`. |
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

Run end-to-end with [run_preprocess.py](preprocess/run_preprocess.py) — it orchestrates four numbered scripts on `.ims` (Imaris HDF5) inputs and writes to `DATA_WEB/3d/<dataset_name>/` (a multi-timepoint acquisition goes to `DATA_WEB/live/` instead).

| Step | Script | Output |
|---|---|---|
| 1 | [1-ims_metadata.py](preprocess/1-ims_metadata.py) | `meta.json` — dataset dimensions, voxel size, channels (parses HDF5 `DataSetInfo`) |
| 2 | [2-image_processor.py](preprocess/2-image_processor.py) | Per-channel `.bin` LOD pyramids — corner-sampling percentile background subtraction (`bg_floor` = 99th percentile of the 8 volume corners, `sig_max` = 99.9th percentile of a subsampled volume; `binary_opening` + `binary_dilation` mask cleanup kills hot pixels while preserving signal fade-out — Otsu was tried and deliberately removed in v0.12.0, see `preprocess/changelog/changelog_0.12.0.md`), masked median filtering, window leveling, downscale, `uint16 → uint8`. **Heavy CPU step.** |
| — | (inline) `build_thumbnail` in `run_preprocess.py` | `thumbnail.webp` — false-color MIP composite |
| 3 | [3-chunk_packer.py](preprocess/3-chunk_packer.py) | `bricks/lodN/...` — splits to 64³ chunks, mosaics into 512² WebP tiles (8×8, `brickPacking.mode = "grid"`), packs into `.bin` packs + `manifest.json`. ESS (Empty Space Skipping) : drops bricks with occupancy < 0.0005. |
| 4 | [4-catalog_generator.py](preprocess/4-catalog_generator.py) | `metadata.json` per dataset — the only place dataset facts are stored; the catalog is derived from it at request time |
| — | [2d_importer.py](preprocess/2d_importer.py) | **Photographs, standalone** (v0.17.0; renamed from `wholemount_importer.py` in v1.51.0). One ImageJ/Leica TIFF → one `DATA_WEB/2d/<name>/` dataset: `image.webp` (native, q90), `preview.webp` (640 px), `thumbnail.webp`, `metadata.json` (type `2d`, `image{}`, `pixelSizeUm` from the TIFF resolution tags, `acquisition{}` from the Leica block, stage/zoom/dissection date from the file name), optional `download/` with the original TIFF. `--force` re-imports but keeps lab-curated keys (`merge_curated`). `python 2d_importer.py --input <dir> --output DATA_WEB --staining X-gal --with-downloads`. |
| 5 | [tracking_sources.py](preprocess/tracking_sources.py) + [5-tracking_importer.py](preprocess/5-tracking_importer.py) | **Timelapses only, automatic.** Finds the cell-tracking analysis in whichever of its three shapes exists — a `.imaris_track` beside the volume, the Imaris Spots/Tracks objects inside the `.ims` (`Scene8/Content`), or the exported `.xls`/`.xlsx` statistics — and writes `tracks.json(.gz)`, `model.glb` and the `tracking`/`registration` blocks of `metadata.json`. The raw shapes are normalised through the lab's own `SCRIPTS/Analysis.py` (cell identity, lineage, Kabsch stabilisation) so both routes give the same result. `--tracking auto\|off\|FILE`. |

**Stage parsing convention** — embryo names like `Egfl7eGFP-E8-5-…` encode stage `E8.5` (regex in `4-catalog_generator.py:_parse_stage`) and embryo id `Em<n>`.

---

## 5. Data layout — `DATA_WEB/`

```
DATA_WEB/
│  (no catalog.json — the dataset index is GENERATED per request, see below)
│  .htaccess                  # execution ban: this tree is web-served AND operator-writable
├── 3d/<dataset>/               # Static volumes
│   ├── metadata.json           # Per-dataset config: "type":"3d", "id":"3d/<dataset>",
│   │                           #   dims, voxels, channels, volumeSources
│   ├── thumbnail.webp
│   ├── gallery/                # optional: operator-attached images (annotated captures,
│   │                           # figures). Indexed by metadata.json `gallery:[{file,caption}]`
│   ├── bricks/
│   │   ├── manifest.json       # Brick index (lod, coords → pack offset/length)
│   │   └── lod0/  lod1/  lod2/ lod3/   # .bin pack files (WebP 8×8 mosaics of 64³ bricks)
│   └── download/               # optional (--with-downloads): original .ims (hardlink), calibrated ImageJ/Fiji composite TIFF, per-channel MIP PNGs, _web.zip, README.txt
├── 2d/<dataset>/               # ONE 2D photograph (no bricks/): image.webp + preview.webp
│                               # + thumbnail.webp + metadata.json (+ download/ original TIFF)
└── live/<dataset>/             # 4D timelapse volumes (same shape + per-timepoint folders);
                                # a TRACKED timelapse adds tracks.json(.gz) + model.glb and a
                                # `tracking` / `registration` block in metadata.json
```

**Dataset types — one vocabulary, three values.** A type is `3d`, `2d` or `live`, and that single spelling is the directory under `DATA_WEB/` **and** under `uploads/staging/`, the first segment of the dataset id (`dataset.id === dataset.path === '<type>/<folder>'`, the same string in `metadata.json`'s `"id"`), the `"type"` field of `metadata.json`, a value of `plugin.json#dataTypes`, the `<type>` of `staging:<type>/<folder>` and of the journal `uploads/state/<type>__<folder>.json`, the `?type=` explorer filter, and the suffix of `badge-<type>` / `type-card--<type>`. There is **no alias and no legacy spelling** : `fixed`, `wholemount` and `tracking` no longer exist as types anywhere in the code — cell tracking is a `tracking` block inside a `live` dataset's metadata, drawn as a layer of the viewer and analysed by the `tracking-*` plugins.

| Type | Directory | Page | Bytes |
|---|---|---|---|
| `3d` | `DATA_WEB/3d/` | `viewer.html` | 64³ brick packs, LOD pyramid |
| `2d` | `DATA_WEB/2d/` | `2d.html` | one calibrated photograph, no bricks, no channels |
| `live` | `DATA_WEB/live/` | `viewer.html` | one brick tree per timepoint; optionally `tracks.json` + `model.glb` (cell tracking) |

The list is declared in `dev_server.py:ALLOWED_TYPE_DIRS`, `upload_staging.py:ALLOWED_TYPE_DIRS` (+ `VOLUME_TYPE_DIRS` for the brick-carrying ones), their PHP twins (`LUMEN_UP_TYPES`, `api/datasets.php:$TYPES`, `_admin_lib.php`, `downloads.php`), and client-side in `Utils.DATASET_TYPES` (§2.3) — `Utils.datasetPage()` is the one place that maps a type to its page. **The type id is never shown to a human** : call `Utils.datasetTypeLabel()` / `datasetTypeTitle()`, which resolve the operator's own names from `config/instance.json` `datasetTypes` before falling back to `types.<type>` in `lang/<code>.json`.

**One-shot migration of an existing deployment.** A host installed before v1.51.0 has its bytes under `DATA_WEB/fixed/` and `DATA_WEB/wholemount/`, its journals under `uploads/state/fixed__*.json`, and `api/stats.json` keyed on `fixed/<folder>`. Both backends run the same **idempotent** conversion at startup — rename the two `DATA_WEB` and `uploads/staging` directories (child by child when the target already exists, name collisions skipped and logged), rename+rewrite the journals, force each `metadata.json`'s `"type"`/`"id"` (and rewrite legacy ids in `linkedTrackingId` / `relatedIds`), re-key `api/stats.json` (summing numeric counters on collision), rename `pageTitles.wholemount`, and rewrite `explorer.html?type=…` hrefs in `config/pages/*.json`. It is guarded by a handful of `is_dir()`/glob checks, so a clean host pays nothing and there is no marker file. This is a migration, **not** a compatibility layer: nothing in the code reads the old words afterwards.

```
uploads/                        # NEVER web-served (see §7). gitignored, _UPDATE_PROTECTed.
├── .htaccess                   # deny-all, written at runtime by ensure_dirs()
├── staging/<type>/<folder>/     # mirrors the final DATA_WEB layout, so publish = a rename
└── state/<type>__<folder>.json  # per-dataset journal: sizes, chunk size, received-bitmap
```

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
| Histogram computation | [js/modules/channels/histogram/index.js](js/modules/channels/histogram/index.js) (data supplied via a `getHistograms` callback from [js/components/channel-panel.js](js/components/channel-panel.js)) |
| Per-channel gaussian blur | [js/modules/channels/gaussian-filter/index.js](js/modules/channels/gaussian-filter/index.js) + [js/workers/gaussian-blur-worker.js](js/workers/gaussian-blur-worker.js) |
| Workspace save / restore | [js/core/workspace-state.js](js/core/workspace-state.js) + [js/core/export-manager.js](js/core/export-manager.js) (wired into `tools/download-center`; also direct buttons on Tracking/Compare pages) |
| Multi-panel compare sync | `compare.js` (parent) + `viewer.js` `postMessage` handlers |
| Admin Datasets tab empty on a PHP host | The whole tab is ONE `api/datasets.php?action=list` answer. Never let one bad row kill it: `admin_json_body` (api/_admin_lib.php) substitutes invalid UTF-8 instead of returning an empty 200, `list_datasets` casts before `strcmp`, each import journal is isolated (`lumen_up_list` / `upload_staging.list_staged`). `apiFetch` logs non-JSON bodies. Test: `tests/test_datasets_list_php.php` (v1.48.0). |
| Dataset CRUD (admin) | [js/pages/admin/tab-datasets.js](js/pages/admin/tab-datasets.js) (registered by [admpan.js](js/pages/admpan.js)) + `api/datasets.php` (or Python equivalent in `dev_server.py`). Datasets still importing appear here too, addressed as `staging:<type>/<folder>` — the editor gates them on `stagingState` (`uploading` = read-only, `editable`/`staged` = full edit). |
| Per-dataset image gallery (annotated captures, figures) | Storage+API: [dev_server.py](dev_server.py) `_gallery_add`/`_gallery_delete`/`_gallery_reconcile` + twin [api/datasets.php](api/datasets.php) `gallery_add`/`gallery_delete`/`gallery_reconcile` (`?action=gallery_add\|gallery_delete`). Bytes in `DATA_WEB/<type>/<ds>/gallery/`, order+captions in `metadata.json` `gallery:[{file,caption}]` (so the catalog carries it for free). Admin UI: the "Galerie d'images" section in [tab-datasets.js](js/pages/admin/tab-datasets.js) (`renderGallery`/`uploadGalleryFiles`). Viewer UI: [dataset-gallery.js](js/components/dataset-gallery.js) (sidebar grid + lightbox). Extension comes from MAGIC BYTES, never the filename; a save reconciles the list against the folder in both directions. Staging datasets are refused (409) — publish first. Tests: `tests/test_dataset_gallery.{py,php}`. Since web v1.45.0. |
| **Import a dataset from the browser** (drag-drop, resumable) | Engine: [upload_staging.py](upload_staging.py) + twin [api/_upload_lib.php](api/_upload_lib.php) (shared journal format — cross-backend resume). HTTP: `dev_server.py:_handle_upload` + [api/upload.php](api/upload.php). UI: [tab-upload.js](js/pages/admin/tab-upload.js) (console) + [upload-manager.js](js/pages/admin/upload-manager.js) (orchestrator, survives tab switches) + [upload-dock.js](js/pages/admin/upload-dock.js) (floating overlay) + [js/workers/upload-worker.js](js/workers/upload-worker.js) (every byte). Styles: `css/admin-upload.css`. Tests: `tests/test_upload_{staging.py,api.py,php.php}`. |
| What files an import accepts / rejects | `upload_staging.classify_path` + twin `_upload_lib.php:lumen_up_classify` — a CLOSED allowlist. Add a pipeline output here (both twins) or it is refused. Tiering (`assign_tiers`) decides upload ORDER, which is what makes a dataset editable early. |
| Staging is unreachable by URL | `uploads/` in `dev_server.py:_FORBIDDEN_ROOTS`, root `.htaccess`, `router.php`, plus a deny-all `uploads/.htaccess` written at runtime by `ensure_dirs()`. Reads go through `api/upload.php?action=blob` (admin session required). `DATA_WEB/.htaccess` separately kills script execution in the PUBLISHED tree (also rewritten at runtime — `DATA_WEB` is in `_UPDATE_PROTECT`, so an update never delivers it). |
| Translations (platform) | `lang/{en,fr,es,nl}.json` — full key parity required. Add a language by dropping `lang/<code>.json` (auto-discovered); display name/flag/RTL come from `LANG_META` in [i18n.js](js/core/i18n.js). |
| **The dataset-type vocabulary** (`3d`/`2d`/`live`) | The rule and the storage/page table are in §5. Client entry point: the "Dataset types" section of [utils.js](js/core/utils.js) (`DATASET_TYPES`, `datasetPage`, `datasetTypeLabel`…), re-exported by [shared.js](js/pages/admin/shared.js). Server lists: `dev_server.py:ALLOWED_TYPE_DIRS`, `upload_staging.py:ALLOWED_TYPE_DIRS`/`VOLUME_TYPE_DIRS`, `api/_upload_lib.php:LUMEN_UP_TYPES`, `api/datasets.php:$TYPES`, `api/_admin_lib.php`, `api/downloads.php`, `install.php` (directory seed). Adding a fourth type means touching every one of them — plus a page in `Utils._TYPE_PAGE`, an icon, a gradient, a `badge-<id>` rule, and `types.<id>` in the four `lang/*.json`. |
| A type's **displayed name** (badge, filter, landing card, select) | Never a literal. `Utils.datasetTypeLabel(type)` / `datasetTypeTitle(type)` resolve, in order: `config/instance.json` `datasetTypes.<type>.{label,title}` (localizable — a flat string or `{en,fr,es,nl}`, read through `InstanceConfig.localized`), then `types.<type>.{label,title}` in `lang/<code>.json`, then the id itself so a page that loaded neither singleton still renders something. `I18n.t('types.<type>.desc')` gives the long description used on the landing cards. Editor: the admin **Types de données** tab. |
| Admin **Types de données** tab (rename the types the public sees) | [tab-dataset-types.js](js/pages/admin/tab-dataset-types.js) — one localizable *label* + *title* per type, written to the `datasetTypes` block of `config/instance.json` through `/api/site.php` (Python `_save_site_doc` + `api/site.php` twin). An **empty** field means "not customized" and lets the translated `types.<type>` default win, so *reset* clears the block rather than writing the current translations into it. It changes names only — never the directories, the ids, the URLs or anything on disk. |
| Translations (a plugin's own strings) | `js/modules/<placement>/<id>/lang/<code>.json` — call `ctx.i18n.t('key')` in `index.js`. List shipped locales in `plugin.json#i18nLanguages`. `en.json` is the mandatory fallback. |
| Scope a plugin to dataset types | Declare `"dataTypes": ["3d", "2d", "live"]` in its `plugin.json` — the **canonical ids of §5**, nothing else. The gate in `PluginRegistry.loadModules(base, paths, { dataType, allowUndeclaredDataTypes })` cuts **both ways** (since v1.50.1): a plugin that declares `dataTypes` loads on those types and on **no other** — that is what keeps a photograph-only tool off the volume viewer; a plugin that declares nothing predates the field and is taken only by a host passing `allowUndeclaredDataTypes` (only `viewer.js` does, so its historical + marketplace plugins are unaffected). Left out ≠ quarantined. No type name is hardcoded in the registry — `viewer.js` passes `datasetMeta.type`, `2d.js` its own. **Renaming a dataset-type id means renaming every `dataTypes` array in lockstep** (including the ones already published to the marketplace, which must be re-packaged with a version bump), or the declaring plugins vanish from both pages. Vector: `tests/js/test_plugin_datatype_gate.mjs`. Today: `screenshot`, `presentation-mode`, `download-center`, `measure-distance`, the `2d`-only `orientation-2d`, `calibrated-grid`, `display-adjust`, `split-view`, `figure-panel`, and the `live`-only `tracking-*` plugins (which also declare `requires: ["tracking"]`, so their toolbar buttons hide on a timelapse without a tracking block) (`orientation-2d` is a plugin **id**, unrelated to the type id `2d`). The page's ctx mirrors the viewer's (`dataset/viewer/measurements/ui/workspace`, `ui.getCanvas`) and adds overlays, orientation, adjustments, physical view, sidebar sections and the collection (see the 2D row in §2.1). |
| Add a new tool | Create `js/modules/tools/<id>/{plugin.json, index.js, lang/}` — auto-discovered, no manifest to edit. `plugin.json` drives the button (`group`, `subtype`, `icon`, `order`, `i18nTitle`→a key in the plugin's `lang/`, optional `tool`/`shortcut`/`requires`/`i18nLanguages`). Toolbar generation: [plugin-registry.js](js/core/plugin-registry.js) `buildToolbarButtons` |
| White-label instance config (brand/specimen/SEO/footer/nav/`datasetTypes`) | `config/instance.json` (public store) ← [js/core/instance-config.js](js/core/instance-config.js); server head injection `{{SITE:…}}` in [dev_server.py](dev_server.py) `_serve_html`/`_apply_site_placeholders` + [api/_html_server.php](api/_html_server.php) `lumen_apply_site`; persisted via `/api/site.php` ([dev_server.py](dev_server.py) `_save_site_doc` + [api/site.php](api/site.php)). Admin UI: [tab-branding.js](js/pages/admin/tab-branding.js). |
| Theme editor (palette/font/radius) | [tab-appearance.js](js/pages/admin/tab-appearance.js) → `config/theme.json` → server-compiled `config/theme.css` ([dev_server.py](dev_server.py) `_generate_theme_css` + `api/site.php` twin); linked after `themes.css` on every public page. |
| Page builder (full-page visual editor) / custom pages / legal | [tab-pages.js](js/pages/admin/tab-pages.js) (launcher + full-screen editor) + [js/core/page-edit-frame.js](js/core/page-edit-frame.js) (in-iframe edit runtime, `?edit=1`) + [js/core/page-renderer.js](js/core/page-renderer.js) + [page.html](page.html) (`?slug=`); home override in `landing.js`. **The About page's default content is [js/core/page-templates.js](js/core/page-templates.js)** — edit the design there, not in `about.html` (which holds no page content since v1.25.0). Legal: [tab-legal.js](js/pages/admin/tab-legal.js) + [legal.html](legal.html). Nav: `InstanceConfig.applyNav`. |
| Guided first-run setup wizard | [js/pages/admin/shell.js](js/pages/admin/shell.js) (5 steps incl. the plugin picker) + the `#setup-screen` markup in [admpan.html](admpan.html). Shows when `api/admin_credential.json` is absent. |
| Plugin marketplace (browse / install / uninstall) | [tab-marketplace.js](js/pages/admin/tab-marketplace.js) + [dev_server.py](dev_server.py) `_marketplace_list`/`_install_marketplace_plugin`/`_uninstall_marketplace_plugin` (+ `api/_admin_lib.php` `mkt_*` twins). Signed catalog under `marketplace/`; pinned key `_MARKETPLACE_PUBKEY_HEX`/`MARKETPLACE_PUBKEY` (separate from core release key). |
| **Publish a plugin to the marketplace** | `python tools/publish_plugin.py <plugin-dir> --push` (one command → live). Package/sign: [tools/build_plugin_release.py](tools/build_plugin_release.py). Full guide: [marketplace/README.md](marketplace/README.md). Plugins are un-bundled from releases ([tools/build_release.py](tools/build_release.py) excludes `js/modules/{tools,channels,shaders}/*`). |
| Cell-tracking tools in the viewer (trails, surface, inspector, charts, cell distance) | The five `js/modules/tools/tracking-*` plugins (§2.6) over the `ctx.tracking` façade built in [viewer.js](js/pages/viewer.js) `_trackingFacade` (data + selection + options + events) and [tracking-overlay.js](js/viewers/tracking-overlay.js) (packed tables, picking). Loader: [js/workers/tracks-load-worker.js](js/workers/tracks-load-worker.js) (`packTracks`, pure — tested in `tests/js/test_tracking_plugins.mjs`). Plugin UI surfaces: `ctx.ui.addSidebarSection` / `addCanvasPanel`; tool changes: `ctx.tools.onChange`; exports: the `getExports()` / `getGraph()` hooks gathered by `PluginRegistry.collect()`. |
| Attach / debug a cell-tracking analysis | [preprocess/tracking_sources.py](preprocess/tracking_sources.py) — `discover`/`read_scene8`/`read_excel`/`build_container`; `python tracking_sources.py <file.ims> --list` shows what would be detected. Priority is `.imaris_track` > embedded `Scene8` > sidebar workbook (a workbook can be stale — measured: one lab dataset's `.xls` held 155 of the volume's 172 spots). Imaris counts frames from 1 everywhere EXCEPT `Scene8`, which counts from 0. |
| Adjust preprocessing background subtraction | [preprocess/2-image_processor.py](preprocess/2-image_processor.py) — corner-sampling percentile (`bg_floor`/`sig_max`) + `binary_opening`/`binary_dilation` |
| Change brick size / ESS threshold | [preprocess/3-chunk_packer.py](preprocess/3-chunk_packer.py) — `BRICK_SIZE`, `occ > 0.0005` |
| Stage / embryo regex | [preprocess/4-catalog_generator.py](preprocess/4-catalog_generator.py) `_parse_stage`, `_parse_embryo` |
| Perf telemetry instrumentation | `PerfTelemetry.start/end/event/setContext` calls scattered in `viewer.js` + [js/core/perf-telemetry.js](js/core/perf-telemetry.js). Note: the old `DOCS/perf_baseline_*.json` snapshots were removed from the repo — regenerate locally if needed. |
| Embryo orientation calibration | [js/modules/tools/orientation-axes/index.js](js/modules/tools/orientation-axes/index.js) (drag gizmo + postMessage to admin) |
| Self-update pipeline (staging swap / rollback / health-gate) | [dev_server.py](dev_server.py) `_run_update` → `_pivot_main` (supervisor) / `_reconcile_pivot` (boot recovery) / `--check` (offline boot gate). **PHP hosts** (since v1.14.2): synchronous one-request update [api/_admin_lib.php](api/_admin_lib.php) `admin_update_apply_php` (download → sha256/Ed25519 verify → staged extract under web root → protected copy-over; busy files parked `*.lumen-new` + `admin_update_finish_pending`). Admin UI: [tab-updates.js](js/pages/admin/tab-updates.js). Design: `DOCS/update-system/`. |
| Release notes shown in the admin (GitHub release body → HTML) | [js/pages/admin/markdown.js](js/pages/admin/markdown.js) — dependency-free Markdown renderer (`renderMarkdown(text, {dropLeadingH1, headingShift})`, `renderInline`), innerHTML-safe by construction: every source char escaped, raw HTML shown as text (`<br>/<kbd>/<sub>/<sup>` the only pass-through tags), links only to `http(s)`/`mailto:` (always `_blank` + `noopener noreferrer`), images become links (CSP `img-src 'self'`), input capped at 64 KiB. `## [TAG]` headings → `adm-md-badge-<tag>` pills. Consumer: [tab-updates.js](js/pages/admin/tab-updates.js) (`.adm-md` / `.adm-release-notes` styles in `css/admin-shell.css`, collapsed box + *Tout afficher*, `publishedAt` date). Test: `tests/js/test_admin_markdown.mjs` renders every changelog ever shipped. Since web v1.52.3. |
| Pipeline pack: detect a newer one / publish it | [dev_server.py](dev_server.py) `_pipeline_remote_assets`/`_pipeline_update_state` + twins [api/_admin_lib.php](api/_admin_lib.php) `admin_pipeline_remote_assets`/`admin_pipeline_update_state`. UI: [tab-pipeline.js](js/pages/admin/tab-pipeline.js) (banner + newer-pack button) and [tab-updates.js](js/pages/admin/tab-updates.js) (`pipelinePackBlock`). **Both editions are release assets** and both are in the signed `SHA256SUMS` ([tools/build_release.py](tools/build_release.py) + `.github/workflows/release.yml`); a pack is named after the PIPELINE version, which is what makes the comparison possible without downloading. Since web v1.44.0. |
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
* …commit datasets in `DATA_WEB/3d|2d|live/` (large binary, gitignored — only `.gitkeep` is tracked; `catalog.json` is generated, not stored).
* …write `fixed`, `wholemount` or `tracking` as a dataset type again, in code, config, a plugin manifest or a test fixture (§5) — cell tracking is a block of a `live` dataset and a set of plugins, never a type or a page. And never hardcode a type's *display* name — that is the operator's, via `Utils.datasetTypeLabel()`.
* …skip the versioning + changelog routine after a substantive edit (rule 1.5).
* …reorder `PluginRegistry.loadModules` to after UI build — channel/shader/tool lists will be empty (lesson from v0.12.45).
