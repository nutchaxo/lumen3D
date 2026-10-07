# Changelog v1.60.1 (Web Platform)

## [FIXED]

- **Plugin exports reachable from the viewer's Download Center**: the viewer collected the plugins' `getExports()` lists and `getGraph()` chart (cell-distance measurements, track, neighbour and lineage tables of the `tracking-*` plugins, the tracking charts) and handed them to `ExportManager`, but the viewer-scope Download Center drew only the dataset's `download/` file explorer, so none of them could be clicked. An *Analysis exports* section now lists the page's and the plugins' exports above the file explorer (a disabled entry keeps its reason), plus *Graph PNG / SVG / CSV* while a plugin shows a chart. The section appears only when there is something to export; entries without a handler or repeating an action are dropped, and a `getGraph` that throws no longer breaks the dialog. Keys `download.analysisTitle` / `download.analysisHint` in the four languages. Test `tests/js/test_export_manager_viewer_exports.mjs`.

## [CHANGED]

- **Viewer measurements exported from the analysis list**: the viewer lists *Measurements CSV / JSON* only when the dataset has measurements, and the generic *Measurements CSV* button beside the file explorer is kept only for a page without its own export list (the Explorer), so the viewer no longer shows the same export twice.
