# Changelog v1.65.0 (Web Platform)

## [ADDED]

- **Format 5 in the browser**: the migration `m005-matrix` now has a browser executor (`js/migrations/m005-matrix.js`), so a host without its own executor, such as a PHP web space, converts its datasets from the admin *Data updates* tab. For each unit, the server names the exact byte runs to read: the tiles of the planes, the stage-A planes of the job, and the format-4 bricks of the native level. The browser reads them in batched requests, computes the unit and posts it. The arithmetic (level average, apron, quantizers, dead zone, mosaics, pack and record layouts) is the Python engine's. The lossless images decode to the same voxels as the server's, and the lossy ones stay within their bounds. On a synthetic two-channel volume converted by the browser through a PHP server, every plane store and cut brick was identical pixel for pixel to the Python executor's result.
- **PHP twin of format 5**: `api/_migrations_m005.php` plans m005 exactly as the Python engine does (same units, empty units, order and stage rule). It serves each unit's inputs, including the stage-A planes of the job's store through `read_ranges`, and checks every uploaded unit before storing it. It assembles the v5 tree at finalize, byte for byte the Python assembly of the same store, then swaps it in, re-stamps the planes and the layer MIPs, sets the version to 5 and keeps the previous tree if asked. It also reads a v5 tree for the status and for repairs.
- **Import of a format-5 dataset**: the admin *Import* tab accepts a v5 brick tree. The column indexes come in the first tier, the packs are tiered by level with the coarsest first, and the XY/XZ/YZ plane stores and the cut bricks come last. Before publishing, both backends check the tree as a whole: every index is the one the manifest hashed and has its grids, every brick lies inside a pack that arrived, and every plane store is present.
- **Local conversion tool**: `tools/convert_dataset.py <DATA_WEB>/<type>/<folder>` runs every pending migration of a dataset on the operator's machine with the Python executor. The journal is the same as the *Data updates* tab's, so an interrupted run resumes. The converted folder can then be dragged into the Import tab of another host.

## [CHANGED]

- **Format 5 is the latest format on every host**: `m005-matrix` is part of the registry on both backends and the latest format is 5. The opt-in switch (`LUMEN_FORMAT5`, `enable_format5`) is gone. A PHP host reports m005 as *browser only*, so the tab converts its datasets in the browser.
- **Migration handlers receive `io` when planning**: `planUnitWork(key, state, io)` can now ask the server about a unit. The worker adds `io.unitInputs()` and `io.readRels()`, which read by path relative to the dataset.
- **Keep the previous version**: the *Data updates* option that keeps the replaced bricks now also covers the 4 → 5 update (`bricks.v4-old/` kept as `bricks.previous/`).

## [FIXED]

- **Tests**: `tests/test_format5_browser_protocol.py` (units computed from `unit_inputs` alone give the server's tree), `tests/test_format5_php_parity.py` (the same units, posted to PHP and Python, give byte-identical trees, plans and inputs), `tests/test_format5_import.py` (allowlist and whole-tree validation, both twins), `tests/test_convert_dataset.py`, `tests/js/test_m005_handler.mjs` (the handler's arithmetic and binary layouts against `format5.py`).
