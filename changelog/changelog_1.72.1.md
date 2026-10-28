# Changelog 1.72.1

## [FIXED]
- **Viewer preview of a dataset still importing**: the staging blob proxy (`api/upload.php?action=blob`, Python and PHP) receives the viewer's `?v=<stamp>` cache stamp glued onto its `path` parameter (`path=/bricks/index.bin?v=…`) and answered 404, so every dataset opened from the Import list failed with `[BrickLoader] index.bin: HTTP 404`. The proxy now ignores everything from the first `?` of `path`.
