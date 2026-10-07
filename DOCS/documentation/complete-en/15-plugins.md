# 15. Plugins, trust and the signed catalogue

::: chapter-intro
- Almost everything you do in the viewer (measuring, capturing, adjusting a histogram, choosing a render mode) is provided by a **plugin**: a small folder that the platform discovers, checks and then plugs in.
- A plugin is **third-party code**. Lumen3D treats it like a phone app: its **identity is checked at installation**, it is given **precise permissions**, and it can be **locked in a box**.
- This chapter explains both sides of the system: **how a plugin works** (§15.1 to §15.11) and **why it can be trusted** (§15.12 to §15.19).
:::

::: analogy
**A smartphone and its app store.** The platform is the phone. A plugin is an app. The signed catalogue is the official store: every app carries a seal. At installation, the phone checks the seal (signature), the file's fingerprint (hash) and compatibility with its own version (platformCompat). It then locks the app in a sandbox and gives it only the permissions it asked for (capabilities).
:::

Chapter 12 explains **how to use** each tool, chapter 13 what is **under the bonnet** of each one, chapter 14 **the screens** of the administration panel. Here we look at **the system that carries them all**.

## 15.1 What is a plugin?

A plugin is a **folder** stored in `js/modules/<placement>/<id>/`. It contains three kinds of file.

![One folder, three kinds of file, three possible destinations.](img-en/ch15/anatomie.svg){width=100%}

| File | Role | Analogy |
|---|---|---|
| `plugin.json` | Who I am, where I go, what I require | The identity card |
| `index.js` | What I do (calls `PluginRegistry.implement`) | The know-how |
| `lang/<code>.json` | My texts in French, English, Spanish, Dutch… | The translated manual |

The **parent folder** decides what the plugin becomes. This is its **placement**.

| Placement | What the visitor sees | Number in the catalogue |
|---|---|---|
| `tools` | A toolbar button (or an exclusive tool) | 23 |
| `channels` | A setting under each fluorescence channel | 2 |
| `shaders` | An entry in the [Render mode]{.ui} menu | 3 |

Total: **28 plugins**, exactly the 28 entries of the signed catalogue (§15.17).

::: note
**Automatic discovery.** There is no list to edit: drop a folder in and it appears; remove it and it disappears. The list is rebuilt every time a page loads (§15.3).
:::

## 15.2 The identity card: `plugin.json`, field by field

Here is the real `plugin.json` of the measurement tool (its fields are explained in the next table).

```json
{
  "id": "measure-distance",   "name": "Measure Distance",   "version": "1.1.4",
  "platformCompat": ">=1.53.0",
  "dataTypes": ["3d", "live", "2d"],   "contexts": ["page", "panel"],
  "creator": "IRIBHM",   "placement": "tools",
  "group": "tools",   "subtype": "tool",   "icon": "ruler",   "order": 20,
  "tool": "measure",   "shortcut": "m",
  "description": "Pick two 3D surface points to measure calibrated physical distance in µm.",
  "i18nTitle": "title",   "i18nLanguages": ["en", "fr", "es", "nl"]
}
```

The loader only **requires** the `id` (and that it equals the folder name). Everything else has a sensible default.

| Field | What it says | Values and rules |
|---|---|---|
| `id` | Unique identity | **Equal to the folder name** (`[A-Za-z0-9_][A-Za-z0-9._-]*`), otherwise quarantine |
| `name`, `creator`, `description` | Display text (catalogue card, Plugins tab) | Free |
| `version` | **The plugin's** version (SemVer) | The catalogue compares it to offer an update |
| `placement` | Where it goes | `tools`, `channels` or `shaders`; must **equal the parent folder** |
| `platformCompat` | Accepted platform versions | Range or list (§15.15); absent = compatible |
| `dataTypes` | Data types covered | `3d`, `2d`, `live`; **absent** = old volume-viewer plugin |
| `contexts` | Where it can live | `page` (full page) and/or `panel` (embedded page); **absent** = `page` only |
| `requires` | Sources it needs | `bricks`, `webstack`, `tracking`; the button stays **hidden** while they are missing |
| `group` | Toolbar cluster | `tools`, `export`, `visuals`, `layouts` |
| `subtype` | Kind of button | `tool`, `toggle`, `action` (channels: `per-channel`) |
| `icon` | Pictogram | Name of a **Lucide** icon |
| `order` | Place in the cluster | Ascending; **999** if absent |
| `tool` | Name of the exclusive tool | Default = the `id`; only for `subtype: "tool"` |
| `shortcut` | Keyboard shortcut | One key, for an exclusive tool (`m` for measure, `c` for slice) |
| `buttonId` | HTML identifier of the button | Plain token, accepted only if no other element carries it |
| `i18nTitle`, `i18nAria` | Keys of the label and of the accessibility text | Looked up in the plugin's `lang/<code>.json` |
| `i18nLanguages` | Languages shipped | The server **recomputes** it from the `lang/` folder |
| `renderModeValue`, `default` | Render modes only | Ray-marcher mode number (0, 1, 2); `default: true` = mode chosen at opening |
| `sandbox`, `sandboxCapabilities` | Plugin written for the sandbox | §15.14 |

::: warning
**A `trust` field in `plugin.json` is ignored.** The plugin is written by a third party: if it could declare its own trust level, the check would be pointless. The registry **deletes** this field and reads the verdict only from the server's answer.
:::

## 15.3 How the platform finds plugins

![Three sources in order of preference, then five steps always in the same order.](img-en/ch15/decouverte.svg){width=100%}

The page asks `PluginRegistry.discover()` for the list. There are three sources; the first one that answers wins.

1. **The server** (`api/plugins.php`, then `api/plugins`: the `.php` address is tried first because it works on both kinds of server). For each plugin it returns the **complete** `plugin.json`, the translations already included and the **trust verdict** (§15.12).
2. **The file `js/modules/manifest.json`**: only `{path, placement, id}` triplets. The server **rewrites** it at every discovery, so that a purely static host inherits an up-to-date list.
3. **The list built into the code**: 17 paths of the historical core. It is a safety net: even if everything else fails, the viewer starts.

The server **filters** before answering: it removes plugins disabled by the administrator, **incompatible** plugins and **untrusted** plugins. An untrusted plugin is therefore not even a candidate for loading.

::: why
**Why wait for everything before drawing anything?** If the toolbar were drawn before the plugins had finished loading, it would appear empty. This rule was broken once (version 0.12.45) and the result was a viewer with no tools. Since then, `discover` and `loadModules` are **always finished** before any interface is built.
:::

::: tech
A folder is taken into account only if its name matches `^[A-Za-z0-9_][A-Za-z0-9._-]*$` (no `..`, no slash) and if its `plugin.json` is readable and does not contradict the parent folder. Otherwise the server **silently ignores** it. Translation tables are attached only if English is present. The answer also carries `devTrust` (is developer mode on?) and `trustEpoch` (§15.14).
:::

## 15.4 Loading: seven barriers

Once it has the list, `loadModules` examines each plugin through a series of checks. The first four are **choices** (does this plugin target this page?); the rest are **safeguards**.

![Each plugin goes through the barriers in order; on the right, what happens to those that fail.](img-en/ch15/barrieres.svg){width=74%}

There are two kinds of failure, not to be confused:

- **Left out** (barriers 3 and 4): the plugin is not made for this page. A 2D photograph tool has no business on a 3D volume. This is **not a fault**: only an information message appears in the console.
- **Quarantined**: something is wrong. The reason is recorded in a register (`PluginRegistry.getQuarantined()`) and a warning appears in the browser console.

::: tech
**Quarantine reasons** (`reason` field): `meta-unreachable` (plugin.json not found), `invalid-meta` (unreadable JSON, id missing or different from the folder, inconsistent placement, plugin.json modified during verification), `incompatible`, `untrusted`, `trust-unavailable` (the trust module is not loaded: as a precaution nothing is run), `sandbox-unsupported-placement`, `sandbox-unavailable`, `sandbox-boot-failed`, `script-failed` (index.js does not load), `no-impl` (index.js never called `implement`), `init-failed` (init threw an exception), `revoked` (approval withdrawn on the fly), `load-error` (other exception).
:::

::: remember
**A broken plugin never costs you the viewer.** Each plugin is loaded, initialised and activated in its own `try/catch`, and a global barrier surrounds the whole plugin phase: even if this entire subsystem failed, the 3D canvas would still start.
:::

## 15.5 Who loads where? `dataTypes` and `contexts`

Two `plugin.json` fields decide whether the plugin is taken on a given page.

:::: cols
::: col
**`dataTypes`**: the dataset **type** (`3d`, `2d`, `live`).

- If present: the plugin runs on these types and **on no other**.
- If absent: it is an old plugin written for the volume viewer; only the 3D / live viewer accepts it (never the 2D page).
:::
::: col
**`contexts`**: the page's **situation**.

- `page`: full page, with its toolbar.
- `panel`: **embedded** page without a toolbar (Compare panel, split-view pane, admin preview).
- If absent: `page` only (**default refusal** in an embedded page).
:::
::::

![Actual result for the 28 plugins, computed from their plugin.json files.](img-en/ch15/matrice.svg){width=100%}

| Page | Plugins loaded |
|---|---|
| 3D volume, full page | **18** |
| 3D volume, in a panel | **12** |
| Timelapse (live), full page | **23** |
| Timelapse (live), in a panel | **15** |
| 2D photograph, full page | **9** |
| 2D photograph, in a panel | **4** |

**Ten plugins are "page only"**: Chunk Debug, Decompose by Channel, Download Center, Figure Panel Builder, Presentation Mode, Screenshot, Screenshot (sandboxed), Split View, Tracking Charts, Cell Distance. A 300-pixel panel cannot host a full screen, a modal menu or a split view inside a split view. **This is not a fault**: the administrator sees it too in the preview of the Datasets tab.

::: example
On the 2D page, the viewer asks for `dataType = 2d`. `measure-distance` declares `["3d","live","2d"]`: taken. `zstack-browser` declares nothing: an old volume-viewer plugin, so **refused** by the 2D page (which does not accept plugins without `dataTypes`). `calibrated-grid` declares `["2d"]`: taken on 2D, absent from the 3D volume.
:::

## 15.6 A plugin's life cycle

![From registration to the end of the page, with quarantine as the emergency exit.](img-en/ch15/cycle-vie.svg){width=100%}

A plugin is an object that `index.js` hands to the registry: `PluginRegistry.implement('my-id', { … })`. The hooks, all optional:

| Hook | Called when | Detail |
|---|---|---|
| `prepare(ctx)` | Before the first brick load | **Initial** state of the scene (e.g. Orientation Axes applies the default view). Synchronous |
| `init(ctx)` | After the volume has loaded | Receives its context (§15.7); may return its instance |
| `activate()` | Button click, or render-mode change | Returns `{ active, icon }` for a toggle |
| `deactivate()` | Deactivation | Back to the "initialized" state |
| `getState()` / `setState(s)` | Workspace save / restore | The states of all plugins are gathered into one object |
| `reset()` | [Reset the workspace]{.ui} | Only plugins that declare it are affected |
| `onLanguageChange()` | Language change | Repaint dynamic texts |
| `getExports()` / `getGraph()` | Download Center opens | §15.9 |
| `dispose()` | End of page | Free resources |

The three **button kinds** (`subtype`) behave differently.

| `subtype` | Behaviour | Example |
|---|---|---|
| `action` | One click, one function, nothing to remember | Screenshot |
| `toggle` | On / off, the state is remembered and given back to the button | Toggle Grid |
| `tool` | **Exclusive tool**: only one active at a time (managed by `ToolManager`) | Measure Distance |

::: example
Here is the Toggle Grid plugin (condensed). Each click cycles the grid from "none" to "normal" to "fine".

```js
PluginRegistry.implement('toggle-grid', {
  init(ctx) { this._ctx = ctx; this._mode = 0; return this; },
  activate() {
    this._mode = (this._mode + 1) % 3;
    VolumeViewer.setGridMode(this._mode);
    return { active: this._mode > 0 };       // the button lights up
  },
  getState() { return { gridMode: this._mode }; },
  setState(s) {
    this._mode = s.gridMode;
    VolumeViewer.setGridMode(this._mode);
    PluginRegistry.syncToolbarButton('toggle-grid', { active: this._mode > 0 });
  },
  reset() { this.setState({ gridMode: 0 }); }
});
```
:::

**Channel** and **render-mode** plugins have contracts of their own: a channel plugin supplies `getChannelUI(channel)` (the HTML) and then `bindChannelUI(…)` (the listeners); a render-mode plugin makes do with its `activate()`, which sets the ray-marcher's mode (chapter 9).

## 15.7 What a plugin receives: the `ctx` object

At `init`, the page hands each plugin a **context**: a façade that gives access to what it needs, nothing more.

![The twelve sections of a plugin's context.](img-en/ch15/contexte.svg){width=100%}

| Section | What it offers |
|---|---|
| `ctx.viewer` | Render modes, slices, views, grid and axes, measurements, `renderNow()` (render the image right now before reading the canvas) |
| `ctx.dataset` | `getMeta()` (the `metadata.json`), `getId()`, `getBasePath()`; on the 2D page also the collection and `open(id)` |
| `ctx.channels` | The state of the channels (colour, window, gamma) |
| `ctx.measurements` | Measurements stored per dataset and per domain |
| `ctx.ui` | `toast`, `addSidebarSection`, `addCanvasPanel`, `getCanvas`, `openStudio`… |
| `ctx.tools` | The current exclusive tool, `activate`, `onChange` |
| `ctx.tracking` | The cell tracking of a timelapse (below) |
| `ctx.workspace` | Read / apply the workspace |
| `ctx.i18n` | `t('key')`: looks up `plugins.<id>.key`, automatic fallback to English |
| `ctx.slicer` | The oblique slice plane |
| `ctx.iframe` | Whether the page is embedded; `postMessage` to the host |
| Miscellaneous | `getCanvasBlob`, `getCustomExports`, `getGraph` |

Each plugin receives **its own copy** of the context: only the `i18n` section differs, because it is tied to the plugin's identifier.

::: tech
**The 2D page's context** has the same shape, with the functions of a photograph: `viewer.getView/setView`, `addOverlay`, `setOrientation`, `setAdjustments`, `getPhysicalView`, `getNativeCanvas`, and `ui.openStudioWith`. A plugin aimed at both pages therefore reads its functions with care (`ctx.viewer.renderNow?.()`).
:::

### Cell tracking: `ctx.tracking`

The five tracking plugins never read `tracks.json` themselves. The page keeps **a single copy** (as compact 32-bit tables) and lends it to them.

| Function | Role |
|---|---|
| `isAvailable()`, `whenLoaded()` | Does the dataset have tracking? Wait until it is loaded |
| `positionUm(cell, frame, options, output)` | Position of a cell, in µm, at a given frame |
| `cellsAt(frame)` | The cells present at that frame |
| `pick(x, y)` | Cell under the cursor (−1 if none) |
| `select(c)`, `getSelected()` | **One selection shared** by all plugins |
| `getOptions()`, `setOptions({ neighborThresholdUm })` | Shared neighbourhood radius (5 to 500 µm) |
| `on('loaded' · 'frame' · 'refresh' · 'selection' · 'options' · 'style', callback)` | Subscribe; returns the unsubscribe function |

Result: clicking a cell in the Inspector also selects it in the trajectories and the charts, without them talking to each other.

### A plugin's texts

A plugin brings its translations in `lang/<code>.json`. They are grafted into the platform's translation tree under `plugins.<id>`. If a language is missing, **English** is shown: a plugin shipped in English only remains usable everywhere.

## 15.8 The toolbar is built, not written

The file `viewer.html` contains **no plugin button at all**. It contains four empty **clusters**: [Tools]{.ui}, [Export]{.ui}, [Visuals]{.ui}, [Layouts]{.ui}, plus one static "Navigation" button. `buildToolbarButtons` then creates one button per tool plugin, from its `plugin.json`.

![The 23 tool plugins, arranged by their group field and sorted by order.](img-en/ch15/barre-outils.svg){width=100%}

For each plugin, the builder:

1. chooses the **cluster** from `group` (a group with no cluster on the page: warning, button ignored);
2. creates an **exclusive tool** button (`subtype: "tool"`, wired by `data-tool`) or an **action / toggle** button (wired by `data-plugin-id`);
3. sets the `icon` pictogram, the `i18nTitle` tooltip (translated, and translated again at every language change) and the accessibility text;
4. **hides** the button if `requires` is not satisfied (`tracking`: the dataset has a tracking block; `bricks` / `webstack`: the source exists);
5. registers the `shortcut` with `ToolManager`.

Result: **the toolbar changes from one dataset to the next**, without a line of page code.

![Toolbar of a 3D volume (demonstration dataset).](img-en/ch15/barre-3d.png){.shot width=100%}

![Toolbar of a tracked timelapse: three more tools (inspector, distance, charts) and two tracking toggles (demonstration dataset).](img-en/ch15/barre-live.png){.shot width=100%}

![Toolbar of a 2D photograph: the five 2D plugins replace the volume tools (demonstration dataset).](img-en/ch15/barre-2d.png){.shot width=100%}

::: tip
**Is your toolbar different from the manual's?** That is normal: the administrator has installed other plugins (chapter 14) or disabled some. A missing button is never a viewer fault.
:::

## 15.9 Plugins and the workspace, exports, embedded pages

### Workspace

Each plugin's `getState()` is gathered into the **same object** as the camera and the channels: this is what the Download Center's [Save state]{.ui} and [Restore state]{.ui} keep, and what the `#state=…` address contains. A plugin without `getState` is not affected. A plugin still "registered" (not yet initialised) is skipped.

### Exports

`getExports()` returns a list of `{ action, handler, … }` entries that the Download Center adds to its own exports. `getGraph()` returns an on-screen chart (Plotly) that the Center knows how to export. The registry **collects** these answers, ignoring any plugin that throws an exception: **a faulty export never makes you lose the platform's exports**.

### Embedded pages (Compare, split view, preview)

An embedded page has no visible toolbar. It therefore **describes** what it offers: `describeToolbar()` lists the exclusive tools and the toggles (with their current state) of only those plugins that accept the `panel` context. The host (the Compare page) **draws its own buttons** from this description, then sends `PLUGIN_ACTIVATE` or `SET_TOOL`; the state comes back through `syncToolbarButton`. The protocol is detailed in chapter 13.

## 15.10 The 28 plugins of the catalogue

**Render modes** (placement `shaders`, loaded everywhere).

| Plugin | In one line |
|---|---|
| Fluorescence | Default rendering: each channel emits its colour (mode 1) |
| Natural Fluorescence | Emission-absorption: dense structures hide what is behind them (mode 2) |
| Structure (DVR) | Volume rendering with depth and occlusion (mode 0) |

**Channels** (placement `channels`).

| Plugin | In one line |
|---|---|
| Histogram Controls | Intensity histogram per channel and min / max / gamma sliders |
| Gaussian Filter | 2D in-plane Gaussian blur, per channel |

**Volume tools** (`3d` and `live`).

| Plugin | Context | In one line |
|---|---|---|
| Slice through Volume | page + panel | Orientable plane slice; the slice takes over the canvas |
| Z-Stack Browser | page + panel | Browse the slices (exclusive with the oblique slice) |
| Measure Distance | page + panel | Two points → distance in µm |
| Decompose by Channel | page | One channel per panel |
| Orientation Axes | page + panel | Orientation gizmo and default view |
| Toggle Grid · Toggle Axes · Hide/Show 3D Volume | page + panel | Grid, axes, volume |
| Chunk Debug | page | Brick boundaries (requires `bricks`) |

**Tools common to all types.**

| Plugin | Context | In one line |
|---|---|---|
| Download Center | page | Files, measurements, metadata, figures, workspace |
| Screenshot | page | PNG capture of the view |
| Screenshot (sandboxed) | page | The same, **in a sandbox** (reference plugin) |
| Presentation Mode | page | Full screen without interface |

**2D photograph tools** (`2d`).

| Plugin | Context | In one line |
|---|---|---|
| Calibrated Grid | page + panel | Physical 1-2-5 grid in µm or mm |
| Display Adjustments | page + panel | Brightness, contrast, gamma, balance, flattening |
| Orientation 2D | page + panel | Rotation and mirror |
| Split View | page | A second photograph side by side |
| Figure Panel Builder | page | Compose a plate from several photographs |

**Cell-tracking tools** (`live`, require `tracking`).

| Plugin | Context | In one line |
|---|---|---|
| Tracking Trails | page + panel | Trajectories over the volume |
| Tracking Surface | page + panel | Specimen surface (`model.glb`) |
| Cell Inspector | page + panel | Metrics, lineage, neighbours, velocity field |
| Tracking Charts | page | Population, speed and mitosis charts |
| Cell Distance | page | Distance between two cells |

## 15.11 Writing a plugin

::: steps
1. Create `js/modules/tools/my-plugin/` (the folder name is the `id`).
2. Write `plugin.json` (at least `id`, `placement`, `group`, `subtype`, `icon`, `order`).
3. Write `index.js` with `PluginRegistry.implement('my-plugin', { … })`.
4. Add `lang/en.json` (mandatory as the fallback), then the other languages.
5. Reload the page: the button appears. On a production site, it first carries the **untrusted** label: approve it (§15.12).
:::

A complete example: a button that shows the dataset's name.

```json
{ "id": "hello-dataset", "name": "Hello Dataset", "version": "1.0.0",
  "platformCompat": ">=1.53.0", "placement": "tools",
  "group": "export", "subtype": "action", "icon": "info", "order": 90,
  "dataTypes": ["3d", "live"], "contexts": ["page"], "creator": "My lab",
  "description": "Shows the name of the open dataset.",
  "i18nTitle": "title", "i18nLanguages": ["en", "fr"] }
```

```js
PluginRegistry.implement('hello-dataset', {
  init(ctx) { this._ctx = ctx; return this; },
  activate() {
    const meta = this._ctx.dataset.getMeta();
    this._ctx.ui.toast(this._ctx.i18n.t('hello') + ' ' + meta.name);
    return { active: false };                 // an action: no state
  },
  dispose() { this._ctx = null; }
});
```

With `lang/en.json`: `{ "title": "Say hello", "hello": "Dataset:" }`.

::: see
The complete guide for authors (channel and render-mode contracts, examples of exclusive tools, good practice) is `DOCS/plugins/guide-creation-plugins.pdf` (the `.tex` source is in the same folder). The tests of this chapter's rules: `tests/js/test_plugin_context_gate.mjs`, `test_plugin_datatype_gate.mjs`, `test_plugin_autonomy.mjs`, `test_plugin_lang.mjs`.
:::

## 15.12 Why be wary of a plugin {.page}

A plugin is a JavaScript file: **real code that runs in the browser of your visitors and of the administrator**. Before version 1.6.0, a plugin had the **full powers of the page**: access to the whole interface, to cookies, and even to the calls reserved for administration. A malicious plugin could have taken control of the site.

Since then, the rule has been **reversed**: *a plugin is not allowed to run until it has been recognised.*

![The server applies these four questions in order; the first "yes" gives the trust level.](img-en/ch15/arbre-confiance.svg){width=100%}

The five levels, from most to least trusted:

| Level | How it is obtained | Where it runs |
|---|---|---|
| `bundled` | Every file of the folder appears, with **the same fingerprint**, in a release's `version.json` | In the page |
| `sandboxed` | The operator approved it in **sandbox** mode (or the plugin declares `sandbox: true`) | In an isolated **iframe** |
| `dev` | The server was launched with `--dev-trust-local` | In the page |
| `approved-trusted` ("approved") | The operator approved it in **in-page** mode | In the page |
| `untrusted` | **Everything else** | **Nowhere** |

Three clarifications about the tree:

- Trust depends on the **content** of the files, never on their path or on the absence of a file. A plugin with the same name as an official plugin but different content is **not** `bundled`.
- A "sandbox" approval **wins** over developer mode: if the operator chose to lock a plugin up, a development machine does not free it.
- The `dev` level is a **positive signal** from the operator (a flag). The presence of a `.git` folder is not one: a production install behind a relay looks exactly the same. Without the flag, a Git clone has **no** trusted local plugin.

::: remember
**The server is the authority.** It classifies; the browser **re-checks**. The plugin itself has no say in the matter.
:::

## 15.13 The fingerprint: a signature of the exact content

To recognise a plugin, the system computes its **fingerprint** (hash): a 64-digit hexadecimal number specific to its content.

![From content to 64 characters, and why a single space changes everything (real example).](img-en/ch15/empreinte.svg){width=100%}

::: analogy
**A digital wax seal.** Change one comma in the letter and the seal no longer matches. It is impossible to make two different plugins that give the same fingerprint.
:::

The exact rules (identical in the three implementations: JavaScript, Python, PHP):

1. Every file of the folder with extension `.js`, `.json`, `.mjs`, `.css` or `.html` gets its SHA-256, computed on the **raw bytes** as served (no line-ending or BOM conversion). Hidden files (leading dot) are ignored; images do not count.
2. The lines `path:fingerprint` are formed, **sorted** by path.
3. The plugin's fingerprint is the SHA-256 of `lumen-plugin-trust/1` + a line feed + these lines.

The **translations** (`lang/*.json`) count: changing one sentence changes the fingerprint. A set of test vectors (`tests/plugin-trust-vector.json`) checks that the three implementations give exactly the same result, including on tricky cases (Windows line endings, BOM).

### Anti-TOCTOU: what is checked is what runs

::: why
**TOCTOU** stands for "time of check, time of use": a file is checked, **then** run, and in between it has changed. It is the classic trick: show a clean file to the inspector and a booby-trapped file at execution.
:::

Lumen3D closes the gap as follows:

1. The browser downloads the bytes of each file **only once**, with no cache for anything that can run.
2. It recomputes the fingerprint on **those** bytes and compares it with the server's verdict. If different: `untrusted`, the plugin is not run.
3. It runs **those same bytes**, through a temporary `Blob` address, never by asking for the file again by its URL.
4. The `plugin.json` that shaped the toolbar and the barriers must be the document that was hashed, otherwise quarantine.

::: tech
Three special cases, for honesty. (1) On an **insecure** address (HTTP on a local-network IP), the browser does not provide `crypto.subtle`: it cannot recompute the fingerprint and relies on the server's verdict, with a console warning. (2) On a **static** host with no trust authority, only `bundled` plugins are recognised, by comparison with `version.json`. (3) With no trust module loaded, nothing is run (fail closed).
:::

## 15.14 Operator approval, and the sandbox

### Approving: tying a YES to precise content

When a plugin is dropped in by hand (by FTP, for example), it is `untrusted`. The administrator approves it in the [Plugins]{.ui} tab (chapter 14): [Approve (sandboxed)]{.ui} or [Approve (in-page)]{.ui}.

The approval is **pinned**:

- the server **recomputes the fingerprint itself** from the disk and requires it to equal the one the operator saw (otherwise "the plugin's content has changed");
- the operator **types their password again**: approving is the only action that lets foreign code run;
- it also records the **capabilities** granted (next section);
- it is written to `api/plugin-trust.json`: `{ path, sha256, mode, caps, date, author }`.

If the content **or** the requested capabilities change, the approval **lapses** ("approval cancelled: content or capabilities modified") and the plugin becomes `untrusted` again. The message is not a fault: it is the system doing its job.

::: tech
The file `api/plugin-trust.json` is **never served** over HTTP, it is protected against updates, and a release that contained one is **refused**: a booby-trapped version therefore cannot pre-approve an attack plugin. Every approval, revocation, installation or uninstallation increments a counter, `trustEpoch`.
:::

### Revocation on the fly

A viewer that is **already open** polls the server (`api/health`, every 8 seconds and when you return to the tab). If `trustEpoch` has changed, it asks again for the list of recognised plugins; any sandboxed plugin that is no longer on it is **destroyed on the spot** and its button disappears.

For an "in-page" plugin, code that has already run cannot be undone: the revocation takes effect **at the next load**. And on a PHP host, which does not emit `trustEpoch`, revocation also takes effect only at the next load.

### The sandbox: an armoured counter with an intercom

![An empty iframe, a monitored intercom, eight message types.](img-en/ch15/bac-a-sable.svg){width=100%}

::: analogy
**An armoured counter.** The plugin works in a closed booth behind it. It cannot see the room (the DOM) and has no telephone (no network). It has an intercom: it asks a question, the clerk (the page) checks that it is entitled to, then answers with **a copy** of the information, never the original.
:::

**The booth**: an `<iframe sandbox="allow-scripts">` **without** `allow-same-origin`. The browser gives it a "null" origin: no access to the page's DOM, cookies, storage or administration calls. An internal policy (`default-src 'none'`, `connect-src 'none'`) forbids any network, worker or sub-frame. A continuous-integration test rejects any change that would add `allow-same-origin`.

**The intercom**: `postMessage` in a `lumen-plugin` namespace, never confused with messages between pages. Each message carries `{ ns, v, dir, id, plugin, token, type, payload }`.

**The plugin's only object**: `window.LumenPlugin`.

| Plugin call | Capability required | Effect |
|---|---|---|
| `addButton({label, icon})` | `toolbar.addButton` | Declares its button |
| `toast(text)` | `ui.toast` | Message (200 characters at most) |
| `getInfo()` | `viewer.getInfo` | Name, dimensions, voxel, number of channels |
| `getCanvasBlob(opts)` | `viewer.getCanvasBlob` | PNG or JPEG image of the view (one request at a time) |
| `download(name, type, data)` | `ui.download` | Download, **on a real click only** |
| `setRenderMode(mode)` | `viewer.setRenderMode` | Change render mode (known modes only) |
| `getChannels()` | `channels.getState` | Copy of the channel state |
| `on('render' · 'channels-updated' · 'camera', f)` | `events.subscribe` | Receive events, as **flat copies** |
| `saveState(s)`, `t('key')` | (none) | Memory for the workspace (256 KiB at most), translation |

The plugin declares in `sandboxCapabilities` what it needs; the operator grants a subset; the **effective** capabilities are the **intersection** of three lists: what the disk declares, what the operator approved, and the closed list of the eight capabilities in the table.

**The checks on every message received**, in this order:

1. the namespace is `lumen-plugin`;
2. the **sending window** is that of a known booth (this is the main authentication: the window's identity is trusted, not the declared origin);
3. the origin is indeed "null";
4. the message's shape and the frame's random **token** are correct;
5. the **rate** is respected: a reserve of 40 messages, refilled at 20 per second;
6. the capability requested has been **granted**; otherwise the answer is `forbidden`.

**Lifetime safeguards**:

| Safeguard | Value |
|---|---|
| Booth start-up (`init`) | 10 s at most, otherwise destroyed |
| Heartbeat (`ping`) | every 1.5 s; booth destroyed after about 6 s without an answer |
| Abuse (invalid or forbidden messages) | more than 50 in 10 s: destroyed |
| Download | one per activation, within 1.5 s of a real click, 32 MiB at most, PNG / JPEG / JSON / CSV / text types, extension imposed by the type |

::: warning
**Only "action" and "toggle" tools can be locked in.** A render mode compiles GLSL code on the graphics card at every frame: there is no asynchronous boundary behind which a booth could stand. A channel plugin receives a piece of the page's DOM directly, exactly the privilege the sandbox removes. These two placements therefore stay in **full trust** (reserved for official plugins), and approving one of them in sandbox mode puts it in quarantine.
:::

::: note
A plugin declared `sandbox: true` **always runs in the booth**, whatever its trust level. Conversely, a plugin written for the page (which calls `PluginRegistry`) cannot work in the booth, which has only the SDK. The reference plugin is `screenshot-sandboxed`: it captures and downloads without ever touching the DOM or the context.
:::

## 15.15 Compatibility: `platformCompat`

A plugin says which platform versions it works with. If the platform changes version, this field stops a plugin that is too old (or too new) from breaking the interface.

| Declaration | Meaning | Platform 1.59.2 |
|---|---|---|
| absent | No constraint | compatible |
| `"*"` or `"x"` | Any version | compatible |
| `">=1.53.0"` | At least this version | compatible |
| `">=1.60.0"` | | **refused** |
| `"^1.4.0"` | From 1.4.0 inclusive to 2.0.0 exclusive | compatible |
| `"~1.58.0"` | From 1.58.0 inclusive to 1.59.0 exclusive | **refused** |
| `"1.x"` or `"1.59"` | Prefix | compatible |
| `["1.58", "1.59.x"]` | List: **any one** of the values is enough | compatible |
| `">=1.51.0 <1.59.0"` | Several comparators: **all** must hold | **refused** |
| `">=banana"`, `42` | Unreadable | **refused** |

Rules: a string separated by spaces is an **AND**; an array is an **OR** ("bare" values only, no operator); three numbers = exact version, fewer numbers = prefix; a `-rc1` suffix is ignored.

::: remember
**Unreadable = incompatible** (fail closed). A declaration that cannot be read never lets anything through. The **only** exception: if the platform's version is unknown (a clone with neither `version.json` nor a development server), the barrier is neutralised and says so in its reason.
:::

::: tech
**Three twins, one behaviour**: `js/core/compat.js` (browser), `dev_server.py` (`_compat_satisfies`), `api/_admin_lib.php` (`admin_compat_satisfies`). They are all validated against `tests/compat-vector.json` (44 cases); any change of semantics must pass all three. The platform version is read from `version.json` (releases), otherwise from `api/health` (development server).
:::

## 15.16 Updating the platform: reversible erasure

![Before, after, later: an incompatible plugin is never deleted.](img-en/ch15/mise-a-jour.svg){width=100%}

When the administrator prepares an update (chapter 18), the **verification report** applies `platformCompat` to the **target** version, plugin by plugin, **before** anything is installed:

- **compatible**: nothing to do;
- **quarantined** (`willQuarantine`): they would no longer work;
- **blocking**: if no **render mode** would remain compatible, the viewer would be unusable: the update cannot be confirmed.

After the switch, nothing is deleted. Discovery **re-filters on every request**: an incompatible plugin disappears from the list (its files stay), and **comes back by itself** as soon as a compatible version of the plugin or of the platform is installed. A plugin dropped in by hand by the operator survives the update: only the files of the **previous release** are replaced.

::: note
Official plugins do **not travel** with the platform: a fresh install starts with no plugin and installs them from the catalogue (§15.17). Compatibility is what keeps this separation safe.
:::

## 15.17 The signed catalogue: the official store {.page}

The **catalogue** is the list of plugins the platform offers to install, from the [Catalog]{.ui} tab or from the first-install wizard (the "recommended" plugins are pre-ticked there). It is **curated**: only the platform's publisher publishes to it.

![The administration Plugins tab: three cards (tools, channels, render modes), a switch and a trust level for each plugin ("dev" on this demonstration machine).](img-en/ch15/admin-plugins.png){.shot width=66%}

![The Catalog tab: "signature verified" at the top, one card per plugin with its mode ("full trust" or "sandbox").](img-en/ch15/admin-catalogue.png){.shot width=66%}

### What the catalogue contains

A file `marketplace-catalog.json`, signed by `marketplace-catalog.json.sig`. It carries `version`, a **serial number** (`serial`), the issue date (`issuedAt`) and one entry per plugin:

| Entry field | Role |
|---|---|
| `id`, `name`, `placement`, `subtype`, `description`, `creator` | The card displayed |
| `latestVersion`, `platformCompat` | Latest version, compatibility |
| `sandboxCapabilities`, `recommended` | Capabilities requested; pre-ticked or not at first install |
| `assetUrl`, `sumsUrl`, `sigUrl` | Where to find the zip, its fingerprints and their signature |
| `sha256` | The **zip's** fingerprint (authenticated by the catalogue's signature) |

Each plugin is published as a **deterministic** zip (sorted entries, date fixed at 1980, permissions 0644: the same content always gives the same bytes) accompanied by `SHA256SUMS`, `SHA256SUMS.sig` and `version.json`.

### Two keys, never the same

![Two independent signature chains: compromising one gives nothing on the other.](img-en/ch15/chaine-signatures.svg){width=100%}

::: analogy
**Two different wax seals.** One authenticates the software's official letters, the other the store's. Stealing or losing one does not let anyone forge the other, and one can be changed without touching the other.
:::

- The signature is an **Ed25519** signature (RFC 8032 standard), verified by a purpose-written module with no dependencies in Python, and by the libsodium library in PHP.
- The **private key** (the seed) never leaves the publisher: environment variable or file outside the Git repository.
- The **public key** is **pinned in the source code** (`dev_server.py`, `api/_admin_lib.php`, `install.php` for releases): it travels with every version and survives updates. A server trusts only what verifies with that precise key.
- **Empty** key in the code: the signature cannot be proven, only the fingerprint is checked, with a warning. **Key filled in**: a missing or false signature **refuses** the catalogue.

### Anti-rollback: the serial number

A stale but still **validly signed** catalogue could be used to reinstall a version of a plugin whose flaw has since been fixed. Each publication therefore **increases** the `serial`. Each server remembers the highest number it has accepted (`api/marketplace-state.json`) and **refuses** a catalogue with a lower number. Only a catalogue whose signature is proven can raise this counter: a false, gigantic number cannot freeze a server.

The administrator then sees "Catalogue refused: it is older…": there is nothing to do on their side.

::: example
At the time of writing, the repository's catalogue is at `serial` 2. A server that has accepted 2 will refuse a catalogue with serial 1, even if its signature is perfectly valid.
:::

## 15.18 Installing, updating, uninstalling

![Ten checks; at the slightest error, everything is put back as it was.](img-en/ch15/installation.svg){width=100%}

Installation is started **by the operator** (password re-entered), never automatically. The steps, in the order of the code:

1. password verified;
2. the catalogue is downloaded (1 MiB at most) and its **signature** verified;
3. its **serial** is compared with the highest already seen;
4. the entry is found, `platformCompat` is compared with the platform version ("incompatible" otherwise);
5. the zip is downloaded, **8 MiB at most**;
6. its SHA-256 must equal that in the **signed catalogue**; without a key, it is compared with `SHA256SUMS` (itself verified);
7. **hardened extraction**: no more than 500 entries or 24 MiB, no absolute path, none with `..`, backslash or drive letter; only plugin file extensions are accepted (never `.php`, `.py`, or a hidden file: the folder is served to the web);
8. `plugin.json`: the `id` and `placement` must equal those of the catalogue;
9. the folder is installed; in the case of an **update**, the old copy is **set aside**, not deleted;
10. the server **recomputes the folder's fingerprint** and **approves** the plugin: `sandbox` if it declares `sandbox: true` (or if it is a tool with capabilities), otherwise `in-page`.

If **any** step fails, the `js/modules/` folder is put back **exactly** in its initial state, including the old version in the case of an update.

**Uninstalling** deletes the folder **and** the approval. The operation is idempotent, and refuses to remove the **last active render mode**.

::: warning
A "full trust" plugin installed from the catalogue **runs in the page**. It is approved because **the publisher signed it and the server verified the signature**, not because it would be harmless. This is also why the catalogue is never opened to third parties.
:::

## 15.19 Publishing a plugin (publisher side)

A single command prepares and publishes:

```text
python tools/publish_plugin.py path/to/my-plugin --push
```

It packages and signs the plugin, adds its entry to the catalogue, **increases the `serial`**, **re-signs** the catalogue and then, with `--push`, commits only the `marketplace/` folder. A plugin is **online** only when these files are on the `main` branch (the catalogue is served from GitHub, `main` branch). The tool refuses a seed whose public key is not the one pinned in the code, because every server would reject the catalogue.

Other options: `--recommended false` (published but not pre-ticked), `--remove <id>` (unpublish), `--resign` (reissue the catalogue under the next serial).

To change a plugin that is already published: **raise `version`** (and raise `platformCompat` if the plugin uses a recent core function with no fallback). Republishing unchanged content produces nothing.

## 15.20 The core modules that make all this work

None of these files is a plugin: they **run** the plugins.

| Module | Role |
|---|---|
| `js/core/plugin-registry.js` (`PluginRegistry`) | Discovery, barriers, life cycle, toolbar, quarantine, revocation on the fly, workspace state |
| `js/core/plugin-trust.js` (`PluginTrust`) | Fingerprint, re-reading the bytes, verdict (client twin of the server) |
| `js/core/plugin-sandbox.js` (`PluginSandbox`) | Create the booths, capability broker, rate limit, heartbeat |
| `js/core/compat.js` (`Compat`) | `platformCompat` resolver; platform version |
| `js/core/tool-manager.js` (`ToolManager`) | **Only one exclusive tool** active at a time; keyboard shortcuts; defaults `v`/Esc (navigate), `c` (slice), `m` (measure) |
| `js/core/ui-actions.js` (`UiActions`) | Header buttons through a `data-action` attribute rather than code in the HTML (the security policy forbids inline code) |
| `js/core/i18n.js` (`I18n`) | Grafts plugin dictionaries under `plugins.<id>`, falls back to English |
| `js/core/export-manager.js`, `workspace-state.js` | Consumers of `getExports()` and `getState()` |
| `js/components/channel-panel.js` | Host of channel plugins (`getChannelUI`, `bindChannelUI`) |
| `js/pages/viewer.js`, `js/pages/2d.js` | Build the `ctx` and call the registry in the order of §15.3 |

On the server side: `dev_server.py` (`_list_plugins`, `_classify_plugin`, `_approve_plugin`, `_marketplace_*`, `_install_marketplace_plugin`) and their PHP twins in `api/_admin_lib.php` and `api/plugins.php`. The **list** of utility modules unrelated to plugins (`Utils`, `Catalog`…) is in the appendix, chapter 20.

## 15.21 A plugin does not show up: what to check?

::: steps
1. Open the browser **console**: every quarantine writes `[PluginRegistry] Quarantined "tools/…" (reason): detail` there.
2. Reason `untrusted`: [Plugins]{.ui} tab, approve it (or it has changed since its approval).
3. Reason `incompatible`: compare its `platformCompat` with your version (§15.15).
4. No quarantine message, just "left out": it does not target this page (`dataTypes`, `contexts`, §15.5).
5. Button missing but plugin loaded: an unsatisfied `requires` (no tracking, no bricks), or a `group` with no cluster.
6. Missing from the Plugins tab: the folder is badly named, or its `plugin.json` is unreadable or contradicts the parent folder.
:::

::: remember
- A plugin = a folder (`plugin.json` + `index.js` + `lang/`); the **parent folder** fixes its placement.
- The page **discovers, filters, verifies, then initialises**, always in this order; a broken plugin never costs you the viewer.
- **Default refusal**: a plugin is run only if it is `bundled`, approved, or developer mode is on.
- Approval is **tied to the exact content** (fingerprint) and to the capabilities; what is checked is what is run.
- The **sandbox** locks in action and toggle tools; channels and render modes stay in full trust.
- The **catalogue** is signed by **its own key**, protected against rollback (serial), and installed **all or nothing**.
:::
