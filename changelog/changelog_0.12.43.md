# Changelog v0.12.43 — Migration complète des modules complexes (Phase 3)

## [ADDED] 5 nouveaux modules tools

### `tools/decompose-channels`
- Wrapper léger autour de `DecompositionPanel` (auto-initialisé par DOMContentLoaded)
- Enregistre le module dans le registre pour la cohérence de l'architecture

### `tools/zstack-browser`
- Migration complète de `_bindZStackBrowser`, `_zstackShow`, `_zstackGoToSlice`, `_zstackNudge`, `_zstackGetDims`, `_zstackPopulateInfo`, `_zstackDrawDiagram`
- Lecture/écriture de l'état partagé (`_zstackActive`, `_zstackCurrentSlice`) via `ctx._state`
- Broadcast inter-iframe `SYNC_ZSTACK_SLICE` préservé
- Workspace state : `{ zstackActive, zstackSlice }`
- `applyState(desired, slice)` délégué par `_applyZstackState` dans viewer.js

### `tools/deepzoom-2d`
- Migration complète de `_bindDeepZoomToggle`, `_enterDeepZoom`, `_exitDeepZoom`, `_updateDzSliceLabel`
- Navigation clavier complète (PageUp/Down, Home, End, Escape)
- Visibilité du bouton conditionnelle à la présence d'une source `deepzoom2d`
- Chargement async du manifest via `DeepZoomViewer.loadManifest`

### `tools/slice-inspector`
- Migration complète de `_initSlicer`, `_slicerSetSpec`, `_slicerBindSlider`, `_slicerSyncSlidersFromSpec`, `_slicerSyncPresetButtons`, `_slicerShow`
- Preset buttons XY/XZ/YZ, sliders position/yaw/pitch/roll/slab, projection select
- Synchronisation bidirectionnelle avec `VolumeViewer.onPlaneSpecChange`

### `tools/measure-distance`
- Migration complète de : pick points, commit measurements, color palette popup, list render, toggle/delete/rename/color actions
- Utilise `ctx.measurements` (facade vers `MeasurementStore`) et `ctx.viewer.setMeasurements`
- Calcul `_dist3d` et formatage `_fmtUm` (µm / mm) en local dans le module
- Workspace state : `{ measurements: [...] }`

## [OPTIMIZED] ViewerContext étendu
- Ajout de `viewer.setClipRange_z`, `viewer.resetClipping`, `viewer.setView`, `viewer.setRotationLocked`, `viewer.resize`, `viewer.setCutPlaneVisible`, `viewer.setMeasurements`, `viewer.onMeasurePoint`, `viewer.onPlaneSpecChange`, `viewer.getPhysicalCalibration`
- Ajout de `slicer.*` (init, setVisible, isVisible, setPlaneSpec, getPlaneSpec, getPreviewCanvas, updateMaterial)
- Ajout de `measurements.*` (list, add, update, remove, clear, setAll)
- Ajout de `ui.escapeHtml`, `ui.createIcons`, `ui.openStudio`, `ui.perf`
- Ajout de `iframe.*` (isIframe, panelIndex, postMessage)
- Ajout de `_state.*` (getters/setters pour les variables partagées : zstackActive, zstackCurrentSlice, suppressZstackSync, suppressSlicerSync, currentTimepoint)

## [OPTIMIZED] viewer.js — Code supprimé
- `_bindDeepZoomToggle`, `_enterDeepZoom`, `_exitDeepZoom` (≈100 lignes) → remplacés par stubs
- `_bindZStackBrowser` (≈55 lignes) → remplacé par stub
- Initialisation du slicer (≈80 lignes) → déléguée au module
- Init appels `_bindDeepZoomToggle()`, `_initSlicer()`, `_bindZStackBrowser()` supprimés de `init()`

## Résultat console
`[ViewerApp] PluginRegistry initialized — 13 tools, 2 shaders`
