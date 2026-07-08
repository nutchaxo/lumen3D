# Changelog v0.12.42 — Module Architecture (Remplacement complet)

## [ADDED] Architecture Modulaire `js/modules/`
- Chaque module est un dossier avec `plugin.json` (métadonnées) + `index.js` (implémentation)
- `plugin.json` contient : `id`, `name`, `version`, `creator`, `placement`, `group`, `icon`, `order`, `description`
- `index.js` appelle `PluginRegistry.implement(id, { init, activate, getState, setState, dispose })`

## [ADDED] `PluginRegistry` v2 (`js/core/plugin-registry.js`)
- Chargement dynamique : `loadModules(basePath, paths)` fetch `plugin.json` puis injecte `index.js`
- Validation du `placement` vs le dossier réel du module
- Séparation metadata (plugin.json) / implémentation (index.js)
- API : `implement()`, `initAll(ctx)`, `activate()`, `deactivate()`, `listByPlacement()`, `listByGroup()`
- Workspace state : `getWorkspaceState()` / `setWorkspaceState()`

## [ADDED] 10 Modules
### Tools (8)
- `tools/toggle-grid` — Grid toggle (none/normal/fine)
- `tools/toggle-axes` — Axes visibility toggle
- `tools/toggle-volume` — Volume visibility toggle + icon swap
- `tools/screenshot` — PNG screenshot capture
- `tools/presentation-mode` — Presentation mode toggle
- `tools/save-workspace` — Workspace save
- `tools/restore-workspace` — Workspace restore
- `tools/download-center` — Export modal

### Shaders (2)
- `shaders/fluorescence` — Fluorescence (Imaris-like), renderMode=1
- `shaders/structure-dvr` — Structure (DVR), renderMode=0

## [OPTIMIZED] viewer.js — Module Integration
- `init()` : chargement dynamique via `PluginRegistry.loadModules()` + `initAll(ctx)`
- Manifest déclaratif dans `init()` (liste des modules à charger)
- Plus aucun `<script>` statique de plugin dans `viewer.html`
- Suppression de `js/plugins/` (ancien dossier plat)

## [OPTIMIZED] viewer.html
- Version CSS bump → `0.12.42`
- Suppression des 12 `<script>` plugin statiques
- Ajout du commentaire `<!-- Modules loaded dynamically -->`
