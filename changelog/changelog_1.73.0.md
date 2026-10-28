# Changelog 1.73.0

## [ADDED]
- **Data integrity tab**: a read-only check-up of every dataset, published or still importing. For each one it reports what is missing (metadata, thumbnail, brick manifest and index, every pack the manifest names and its length, planes and mips of its format, gallery images and tracking files that metadata lists), what is extra (files in the pipeline trees no import would accept, leftovers of an interrupted update, gallery files metadata does not list, a kept previous brick tree) and whether the dataset is in the latest format (pending migrations, repairs, a damaged tree). An import in progress is judged by the same validation the publish step runs. Results arrive dataset by dataset, with a filter for datasets that have findings.
- **Integrity endpoint**: `api/integrity.php` (`list`, `check`) on PHP hosts and `/api/integrity.php` on the Python server, both read-only and admin-session only, built on the validators of the import and the migrations (`dataset_integrity.py`, `api/_integrity_lib.php`). Test `tests/test_integrity_parity.py` runs both engines on the same tree and requires the same verdicts.

## [CHANGED]
- **Data updates and imports in progress**: Data updates still lists only published datasets; the integrity tab is where an import still in progress is checked.
