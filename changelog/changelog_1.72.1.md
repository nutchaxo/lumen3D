# Changelog 1.72.1

## [FIXED]
- **Viewer preview of a dataset still importing**: the staging blob proxy (`api/upload.php?action=blob`, Python and PHP) receives the viewer's `?v=<stamp>` cache stamp glued onto its `path` parameter (`path=/bricks/index.bin?v=…`) and answered 404, so every dataset opened from the Import list failed with `[BrickLoader] index.bin: HTTP 404`. The proxy now ignores everything from the first `?` of `path`.

## [CHANGED]
- **Unreadable import items are named**: when the browser refuses a file or folder of a dropped import, its path and the error are written to the console (`[import] unreadable …`) instead of only being counted.
