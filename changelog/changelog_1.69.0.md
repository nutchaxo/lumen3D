# Changelog v1.69.0 (Web Platform)

## [ADDED]

- **Storage tab (Stockage) in the admin panel**: a new tab under *Données* shows where the disk of the platform goes. It reports the capacity of the volume that holds the install, the space used and the space still free, and a bar that splits the volume into published data, imports and trash, the platform's code, other files on the same volume, and free space. Below it, three cards break the platform's own share down: published datasets per type (with the number of datasets), the import staging and the trash, and the code (plugins, vendored libraries, styles, API, translations, Git history, local Python environment, logs…). A table lists every dataset by size and file count, with its largest folders (bricks, planes, mips, downloads, gallery…).
- **Storage report endpoint**: `api/admin.php?action=storage` (and `dev_server.py`'s twin) returns the report. The walk of the install is cached for ten minutes, so opening the tab again is instant; *Recalculer* forces a new walk. The free space is read on every request.
- **Hard links counted once**: a file linked into two places (format-4 `ll` columns shared with `bricks.previous/`, the download hard link) takes its bytes once in the report, as it does on the disk.

## [CHANGED]

- **Free space is the volume's**: on a shared host with a quota stricter than the volume, the tab shows the volume's free space, not the quota. The note on the tab says so.

## [OPTIMIZED]

- **Storage walk in one pass**: the whole install is totalled in a single walk (about 2 s on the development tree, 1.8 s in Python and 2.4 s in PHP), each file classified once. The walk is cached, so the tab costs nothing on the next open.

- **Two backends, one report**: `tests/test_storage_report.py` and `tests/test_storage_report_php.php` pin the classification table of `dev_server.py` and `api/_admin_lib.php` and check the hard-link rule and the cache.
