<?php
/**
 * IRIBHM Microscopy Platform — public catalog endpoint
 * ====================================================
 * Builds the dataset catalog by scanning DATA_WEB/<type>/<name>/metadata.json on every
 * request, and returns it. Nothing is cached and no file is consulted.
 *
 * Why there is no catalog.json behind this
 * ----------------------------------------
 * The catalog holds NO information of its own: every field is either copied from a
 * dataset's metadata.json (name, channels, stage, dimensions, voxel size…), derived
 * from it (physicalSizeUm = dimensions x voxel_size), or deduced from the directory
 * (thumbnail if the file exists, volumeSources by probing bricks/manifest.json). It is
 * a pure projection, so a persisted copy can only ever be right by accident.
 *
 * It used to be a static file that only rebuild_catalog() rewrote, and that only ran
 * from the admin panel — so a dataset uploaded by SFTP, which is the documented way to
 * add one, stayed invisible until someone clicked "Régénérer catalog.json". Serving it
 * dynamically removes the failure mode instead of papering over it with cache
 * invalidation, which mtime cannot do reliably anyway: mtimes have one-second
 * resolution, so two changes inside the same second are indistinguishable.
 *
 * Cost: one scandir per type plus one metadata.json read per dataset, per request.
 * That is O(datasets) on a page load — fine at this scale (tens of datasets, a few
 * hundred KB), and the reason the Python server keeps an mtime cache instead
 * (dev_server.py, PERF-035). If this instance ever grows to hundreds of datasets with
 * large per-timepoint metadata, put a cache back HERE rather than in a file the
 * operator can desynchronise.
 *
 * Wired in .htaccess and router.php:
 *   RewriteRule ^DATA_WEB/catalog\.json$ api/catalog.php [L,QSA]
 * Without mod_rewrite Apache serves the static DATA_WEB/catalog.json instead, which is
 * whatever the admin panel last generated.
 *
 * Public on purpose: the catalog is public data. No session, no auth, read-only.
 */

declare(strict_types=1);

define('LUMEN_DATASETS_LIB', 1);
require_once __DIR__ . '/datasets.php';   // library mode: rebuild_catalog() only

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

echo json_encode(rebuild_catalog(), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
